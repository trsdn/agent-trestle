export function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array");
  const byId = new Map();
  for (const task of tasks) {
    if (!task || typeof task.id !== "string" || task.id.length === 0) {
      throw new TypeError("every task must have a non-empty string id");
    }
    if (typeof task.run !== "function") {
      throw new TypeError(`task ${task.id} must provide run(context)`);
    }
    if (byId.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    byId.set(task.id, { ...task, dependsOn: [...(task.dependsOn ?? [])] });
  }
  for (const task of byId.values()) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`task ${task.id} has unknown dependency: ${dependency}`);
      }
      if (dependency === task.id) {
        throw new Error(`task ${task.id} cannot depend on itself`);
      }
    }
  }
  detectCycle(byId);
  return byId;
}

function detectCycle(byId) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`task graph contains a cycle at: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

export function readyTasks(byId, states) {
  return [...byId.values()].filter(
    (task) =>
      states.get(task.id) === "pending" &&
      task.dependsOn.every((id) => states.get(id) === "completed"),
  );
}

