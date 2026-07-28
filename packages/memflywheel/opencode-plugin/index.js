import { createOpenCodePluginServer } from "../dist/index.js";

export async function server(input, options) {
  return createOpenCodePluginServer(input, options);
}

export default server;
