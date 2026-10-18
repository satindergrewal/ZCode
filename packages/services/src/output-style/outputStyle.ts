import type { OutputStyle, OutputStyleConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IOutputStyleService {
  /**
   * Loads every available output style
   */
  listStyles(): Promise<{ styles: OutputStyle[] }>;

  /**
   * Adds a new output style
   */
  addStyle(params: { config: OutputStyleConfig }): Promise<void>;

  /**
   * Updates an existing output style
   */
  updateStyle(params: { id: string; config: OutputStyleConfig }): Promise<void>;

  /**
   * Deletes an output style
   */
  deleteStyle(params: { id: string }): Promise<void>;

  /**
   * Returns the user output styles directory
   */
  getUserStylesDirectory(): Promise<{ path: string }>;

  /**
   * Sets the active output style
   */
  setActiveStyle(params: { styleId: string }): Promise<void>;

  /**
   * Returns the active output style
   */
  getActiveStyle(): Promise<{ styleId: string | null }>;
}

export const IOutputStyleService = createServiceDescriptor<IOutputStyleService>(
  ServiceChannels.OutputStyle,
);
