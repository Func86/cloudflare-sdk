/** The entry module of the plugin, which `forge-plugin build` compiles to `generator/sdk.wasm`. */
import { definePlugin } from '@cloudflare/forge/plugin';
import { generateFiles } from './plugin/index.ts';

// eslint-disable-next-line @typescript-eslint/unbound-method -- Forge's documented entry; its methods don't use `this`.
export const { generate, generateGroup } = definePlugin({ generate: generateFiles });
