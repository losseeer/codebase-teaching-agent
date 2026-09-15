import { helper } from "./util.js";
import { value } from "@demo/lib";

export function run(): string {
  return helper() + String(value);
}
