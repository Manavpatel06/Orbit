// MongoDB storage for the Orbit relay. Exposes a small async store interface
// (see createMongoStore) so handlers/logic can be tested against any fake.

const NO_ID = { projection: { _id: 0 } };

function dupAware(fn) {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (e && e.code === 11000) {
        const err = new Error('duplicate');
        err.dup = true;
        throw err;
      }
      throw e;
    }
  };
}

export function createMongoStore(db) {
  const c = {
    circles: db.collection('circles'),
    members: db.collection('members'),
    signals: db.collection('signals'),
    proposals: db.collection('proposals'),
    log: db.collection('log'),
  };
  return {
    createCircle: dupAware((circle) => c.circles.insertOne({ ...circle })),
    getCircle: (code) => c.circles.findOne({ code }, NO_ID),
    async deleteCircleAll(code) {
      await Promise.all(['circles', 'members', 'signals', 'proposals', 'log'].map((n) => c[n].deleteMany(n === 'circles' ? { code } : { circle_code: code })));
    },
    countMembers: (code) => c.members.countDocuments({ circle_code: code }),
    listMembers: (code) => c.members.find({ circle_code: code }, NO_ID).sort({ joined_at: 1, member_id: 1 }).toArray(),
    getMember: (code, id) => c.members.findOne({ circle_code: code, member_id: id }, NO_ID),
    getMemberByTokenHash: (hash) => c.members.findOne({ token_hash: hash }, NO_ID),
    insertMember: dupAware((m) => c.members.insertOne({ ...m })),
    async setMember(code, id, set) {
      await c.members.updateOne({ circle_code: code, member_id: id }, { $set: set });
    },
    async deleteMember(code, id) {
      await c.members.deleteOne({ circle_code: code, member_id: id });
    },
    async putSignal(sig) {
      await c.signals.replaceOne({ circle_code: sig.circle_code, member_id: sig.member_id }, sig, { upsert: true });
    },
    getSignal: (code, id) => c.signals.findOne({ circle_code: code, member_id: id }, NO_ID),
    listSignals: (code) => c.signals.find({ circle_code: code }, NO_ID).toArray(),
    async deleteSignal(code, id) {
      await c.signals.deleteOne({ circle_code: code, member_id: id });
    },
    insertProposal: (p) => c.proposals.insertOne({ ...p }),
    getProposal: (id) => c.proposals.findOne({ id }, NO_ID),
    listProposals: (code) => c.proposals.find({ circle_code: code }, NO_ID).sort({ created_at: 1 }).toArray(),
    async updateProposal(id, set) {
      await c.proposals.updateOne({ id }, { $set: set });
    },
    /** Atomic: records one member's answer on a still-open proposal. Returns the updated proposal or null. */
    setResponse: (id, memberId, answer) => c.proposals.findOneAndUpdate({ id, status: 'open' }, { $set: { [`responses.${memberId}`]: answer } }, { returnDocument: 'after', projection: { _id: 0 } }),
    /** Atomic compare-and-set: applies `set` only if the proposal matches `match` (e.g. {status:'open'}). Returns the updated proposal or null. */
    transitionProposal: (id, match, set) => c.proposals.findOneAndUpdate({ ...match, id }, { $set: set }, { returnDocument: 'after', projection: { _id: 0 } }),
    async deleteProposals(ids) {
      if (ids.length) await c.proposals.deleteMany({ id: { $in: ids } });
    },
    async addLog(entry) {
      await c.log.insertOne({ ...entry });
    },
    listLog: (code, limit) => c.log.find({ circle_code: code }, NO_ID).sort({ ts: -1 }).limit(limit).toArray(),
    /** mapper(entry) -> object of fields to $set, or null to leave the entry alone. */
    async scrubLog(code, mapper) {
      const ops = [];
      for await (const e of c.log.find({ circle_code: code })) {
        const set = mapper(e);
        if (set) ops.push({ updateOne: { filter: { _id: e._id }, update: { $set: set } } });
      }
      if (ops.length) await c.log.bulkWrite(ops);
    },
  };
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('circles').createIndex({ code: 1 }, { unique: true }),
    db.collection('members').createIndex({ circle_code: 1, member_id: 1 }, { unique: true }),
    db.collection('members').createIndex({ token_hash: 1 }),
    db.collection('signals').createIndex({ circle_code: 1, member_id: 1 }, { unique: true }),
    db.collection('signals').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db.collection('proposals').createIndex({ id: 1 }, { unique: true }),
    db.collection('proposals').createIndex({ circle_code: 1, created_at: 1 }),
    db.collection('log').createIndex({ circle_code: 1, ts: -1 }),
    // bound growth: old log entries and proposals expire after 30 days
    db.collection('log').createIndex({ ts: 1 }, { expireAfterSeconds: 30 * 86400 }),
    db.collection('proposals').createIndex({ created_at: 1 }, { expireAfterSeconds: 30 * 86400 }),
  ]);
}

/** Cached across invocations on globalThis; indexes ensured once per cold start. */
export async function getStore() {
  if (!globalThis.__orbitStore) {
    globalThis.__orbitStore = (async () => {
      // Tolerate stray whitespace, quotes or backticks pasted into the dashboard.
      const raw = process.env.MONGODB_URI || '';
      let uri = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/^MONGODB_URI\s*=\s*/, '').trim();
      if (!uri) throw new Error('MONGODB_URI is not set');
      // If only the database password was provided, build the URI from MONGODB_USER / MONGODB_HOST.
      if (!uri.includes('://')) {
        const user = process.env.MONGODB_USER || 'orbit-relay';
        const host = process.env.MONGODB_HOST || 'orbit.lnykdve.mongodb.net';
        uri = `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(uri)}@${host}/?retryWrites=true&w=majority&appName=orbit`;
      }
      if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
        throw new Error(`MONGODB_URI has an invalid scheme (starts with "${uri.slice(0, 8).replace(/[^a-z+:/]/gi, '?')}", length ${uri.length})`);
      }
      const { MongoClient } = await import('mongodb');
      const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'orbit');
      await ensureIndexes(db);
      return createMongoStore(db);
    })().catch((e) => {
      globalThis.__orbitStore = null;
      throw e;
    });
  }
  return globalThis.__orbitStore;
}
