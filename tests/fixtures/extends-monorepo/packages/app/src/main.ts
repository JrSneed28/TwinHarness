// Imports an aliased specifier whose alias is declared ONLY in the inherited base
// config (configs/tsconfig.base.json) and reaches here via `extends`. AC#3 must
// resolve this to packages/app/src/util.ts with basis:"alias".
import { helper } from "@app/util";

export function run(): number {
  return helper();
}
