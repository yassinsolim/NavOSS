import { describe, expect, it } from 'vitest';

import {
  type LinearConstraint,
  type LinearProgram,
  solveLinearProgram,
} from '../src/calgary-travel-times/linear-program.js';

// Park-Miller, reproducible.
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

/** Solves a square system by Gaussian elimination; undefined when it is singular. */
function solveSquare(matrix: number[][], rhs: number[]): number[] | undefined {
  const size = rhs.length;
  const rows = matrix.map((row, index) => [...row, rhs[index] ?? 0]);
  for (let column = 0; column < size; column += 1) {
    let best = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row]?.[column] ?? 0) > Math.abs(rows[best]?.[column] ?? 0)) best = row;
    }
    if (Math.abs(rows[best]?.[column] ?? 0) < 1e-9) return undefined;
    [rows[column], rows[best]] = [rows[best] ?? [], rows[column] ?? []];
    const pivot = rows[column] ?? [];
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const line = rows[row] ?? [];
      const factor = (line[column] ?? 0) / (pivot[column] ?? 1);
      for (let index = column; index <= size; index += 1) {
        line[index] = (line[index] ?? 0) - factor * (pivot[index] ?? 0);
      }
    }
  }
  return rows.map((row, index) => (row[size] ?? 0) / (row[index] ?? 1));
}

function combinations(count: number, choose: number): number[][] {
  if (choose === 0) return [[]];
  if (count < choose) return [];
  return [
    ...combinations(count - 1, choose - 1).map((rest) => [...rest, count - 1]),
    ...combinations(count - 1, choose),
  ];
}

/** The optimum over every vertex of the polyhedron, or undefined when it is empty. */
function bruteForce(program: LinearProgram): number | undefined {
  const variables = program.objective.length;
  // Every constraint as an equation, then x_j = 0 for each variable.
  const planes: { coefficients: number[]; value: number }[] = [
    ...program.constraints.map((constraint) => ({
      coefficients: [...constraint.coefficients],
      value: constraint.value,
    })),
    ...program.objective.map((_, column) => ({
      coefficients: program.objective.map((__, index) => (index === column ? 1 : 0)),
      value: 0,
    })),
  ];
  const feasible = (x: number[]) =>
    x.every((value) => value >= -1e-7) &&
    program.constraints.every((constraint) => {
      const left = constraint.coefficients.reduce(
        (sum, weight, column) => sum + weight * (x[column] ?? 0),
        0,
      );
      if (constraint.relation === '<=') return left <= constraint.value + 1e-7;
      if (constraint.relation === '>=') return left >= constraint.value - 1e-7;
      return Math.abs(left - constraint.value) <= 1e-7;
    });
  let best: number | undefined;
  for (const chosen of combinations(planes.length, variables)) {
    const x = solveSquare(
      chosen.map((index) => planes[index]?.coefficients ?? []),
      chosen.map((index) => planes[index]?.value ?? 0),
    );
    if (x === undefined || !feasible(x)) continue;
    const value = program.objective.reduce(
      (sum, weight, column) => sum + weight * (x[column] ?? 0),
      0,
    );
    best = best === undefined ? value : Math.min(best, value);
  }
  return best;
}

describe('dense simplex for the City delay fit', () => {
  it('matches vertex enumeration on small random programs', () => {
    let infeasible = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = seeded(seed);
      const variables = 1 + Math.floor(random() * 4);
      const rows = 1 + Math.floor(random() * 5);
      const constraints: LinearConstraint[] = Array.from({ length: rows }, () => {
        const pick = random();
        return {
          coefficients: Array.from({ length: variables }, () => Math.floor(random() * 5) - 1),
          relation: pick < 0.45 ? '<=' : pick < 0.9 ? '>=' : '=',
          value: Math.floor(random() * 21) - 4,
        };
      });
      // Non-negative costs keep the minimum bounded on x >= 0.
      const objective = Array.from({ length: variables }, () => Math.floor(random() * 4));
      const program = { constraints, objective };
      const expected = bruteForce(program);
      const solution = solveLinearProgram(program);
      if (expected === undefined) {
        infeasible += 1;
        expect(solution.status, `seed ${String(seed)}`).toBe('infeasible');
        continue;
      }
      expect(solution.status, `seed ${String(seed)}`).toBe('optimal');
      if (solution.status !== 'optimal') continue;
      expect(solution.value).toBeCloseTo(expected, 6);
      // The returned point is itself feasible.
      for (const constraint of constraints) {
        const left = constraint.coefficients.reduce(
          (sum, weight, column) => sum + weight * (solution.x[column] ?? 0),
          0,
        );
        if (constraint.relation !== '>=') expect(left).toBeLessThanOrEqual(constraint.value + 1e-6);
        if (constraint.relation !== '<=') {
          expect(left).toBeGreaterThanOrEqual(constraint.value - 1e-6);
        }
      }
    }
    expect(infeasible).toBeGreaterThan(20);
    expect(infeasible).toBeLessThan(380);
  });

  it('reports an unbounded minimum', () => {
    expect(
      solveLinearProgram({
        constraints: [{ coefficients: [1, -1], relation: '<=', value: 2 }],
        objective: [0, -1],
      }).status,
    ).toBe('unbounded');
  });
});
