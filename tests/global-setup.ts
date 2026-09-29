import { MongoMemoryServer } from "mongodb-memory-server";

/** One throwaway MongoDB for the whole run. Each test file gets its own database inside it. */
export default async function globalSetup() {
  const mongo = await MongoMemoryServer.create();
  process.env.TEST_MONGO_URI = mongo.getUri();

  return async () => {
    await mongo.stop();
  };
}
