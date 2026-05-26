#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import("../src/features/proc/cli.ts");
await mod.main(process.argv.slice(2));
