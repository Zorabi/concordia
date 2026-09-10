import { ConcordiaDatabase } from "./database.js";
import {
  ConcordiaException,
  type ActorRole,
  type ClaimTaskInput,
  type ClaimTaskResult,
  type TaskDetail,
  type TaskEvent,
  type WaitEventsInput,
} from "./protocol.js";
import { createRedisRelayServiceFromEnv, type RedisRelayService } from "./relay-client.js";
import { TaskService } from "./tasks.js";
import { WorkspaceManager } from "./workspace.js";

export interface WakerEventSource {
  waitEvents(input: WaitEventsInput): Promise<TaskEvent[]>;
  getTask(taskId: string, recentEventLimit?: number): Promise<TaskDetail>;
  claimTask(input: ClaimTaskInput): Promise<ClaimTaskResult>;
  close(): Promise<void>;
}

export async function createWakerEventSource(role: ActorRole): Promise<WakerEventSource> {
  const transport = process.env.CONCORDIA_TRANSPORT ?? "stdio";
  if (transport === "stdio") {
    const database = new ConcordiaDatabase();
    const service = new TaskService(database, new WorkspaceManager());
    return {
      waitEvents: async (input) => service.waitEvents(input),
      getTask: async (taskId, eventLimit) => service.getTask(taskId, eventLimit),
      claimTask: async (input) => service.claimTask(input),
      close: async () => database.close(),
    };
  }
  if (transport === "redis") {
    const relay: RedisRelayService = createRedisRelayServiceFromEnv(role);
    await relay.connect();
    return {
      waitEvents: (input) => relay.waitEvents(input),
      getTask: (taskId, eventLimit) => relay.getTask(taskId, eventLimit),
      claimTask: (input) => relay.claimTask(input),
      close: () => relay.close(),
    };
  }
  throw new ConcordiaException("INVALID_INPUT", "CONCORDIA_TRANSPORT must be stdio or redis");
}
