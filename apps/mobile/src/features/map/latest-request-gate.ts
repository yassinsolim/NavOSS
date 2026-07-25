export interface LatestRequestGate {
  advance: () => number;
  isCurrent: (generation: number) => boolean;
}

export function createLatestRequestGate(): LatestRequestGate {
  let currentGeneration = 0;

  return {
    advance: () => {
      currentGeneration += 1;
      return currentGeneration;
    },
    isCurrent: (generation) => generation === currentGeneration,
  };
}
