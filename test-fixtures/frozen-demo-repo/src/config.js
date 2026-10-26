export function loadGreeting(environment) {
  return environment.GREETING || "hello";
}
