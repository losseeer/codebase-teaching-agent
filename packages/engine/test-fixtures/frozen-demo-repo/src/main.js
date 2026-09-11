import { loadGreeting } from "./config.js";
import { formatGreeting } from "./presenter.js";

export function start(environment) {
  return formatGreeting(loadGreeting(environment));
}
