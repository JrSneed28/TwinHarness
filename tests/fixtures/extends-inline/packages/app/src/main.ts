// Same import as the extends fixture, but the alias is declared INLINE (no extends).
import { helper } from "@app/util";

export function run(): number {
  return helper();
}
