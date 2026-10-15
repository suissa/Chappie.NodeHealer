import { NodeHealer, formatTerminalEvent } from "../src/index.mjs";

const error = `npm error code ERESOLVE
npm error ERESOLVE could not resolve
npm error
npm error While resolving: @lovable.dev/vite-tanstack-config@2.1.1
npm error Found: nitro@3.0.260603-beta
npm error node_modules/nitro
npm error   dev nitro@"^3.0.260603-beta" from the root project
npm error
npm error Could not resolve dependency:
npm error peerOptional nitro@">=3.0.260429-beta" from @lovable.dev/vite-tanstack-config@2.1.1
npm error node_modules/@lovable.dev/vite-tanstack-config
npm error   dev @lovable.dev/vite-tanstack-config@"^2.1.1" from the root project
npm error
npm error Conflicting peer dependency: nitro@3.0.260429-beta
npm error node_modules/nitro
npm error   peerOptional nitro@">=3.0.260429-beta" from @lovable.dev/vite-tanstack-config@2.1.1
npm error
npm error Fix the upstream dependency conflict, or retry this command with --force or --legacy-peer-deps to accept an incorrect (and potentially broken) dependency resolution.`;

const healer = new NodeHealer({ onTerminal: async (event) => {
  console.log(formatTerminalEvent(event));
  return "defer";
}});
const result = await healer.heal(error);
console.log("\nSTATUS:", result.status);
console.log("COMMAND RETURNED:", result.diagnosis.candidates[0]?.command ?? "(none)");
