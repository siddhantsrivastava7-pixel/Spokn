import type { LocalSTTBackend } from "../backend/backendTypes";
import type { WindowsModelStore } from "../models/WindowsModelStore";

export interface WindowsSTTRuntimeAdapterOptions {
  modelStore?: WindowsModelStore;
  backend?: LocalSTTBackend;
}
