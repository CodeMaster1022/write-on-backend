import mongoose from "mongoose";
import { env, isProd } from "./env.js";

mongoose.set("strictQuery", true);

export async function connectDb(): Promise<void> {
  if (!isProd) mongoose.set("debug", false);

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
  });

  console.log(`[db] connected to ${mongoose.connection.name}`);

  mongoose.connection.on("disconnected", () => console.warn("[db] disconnected"));
  mongoose.connection.on("error", (err) => console.error("[db] error", err));
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
