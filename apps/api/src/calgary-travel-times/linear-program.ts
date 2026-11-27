/**
 * A small dense two-phase simplex for the City delay fit: minimise `objective · x` subject to
 * linear constraints and `x >= 0`. The problems it serves have tens of variables and rows, so
 * a dense tableau is the simplest exact method. Bland's rule (lowest index enters, lowest basic
 * index leaves on a tie) rules out cycling, so the method always terminates; the pivot limit is
 * a guard against a bug, not a state the solver reaches.
 */

export interface LinearConstraint {
  coefficients: readonly number[];
  relation: '<=' | '=' | '>=';
  value: number;
}

export interface LinearProgram {
  constraints: readonly LinearConstraint[];
  /** Minimised; one coefficient per variable. */
  objective: readonly number[];
}

export type LinearSolution =
  | { status: 'infeasible'; /** Phase-one optimum: the least total violation. */ shortfall: number }
  | { status: 'optimal'; value: number; x: number[] }
  | { status: 'unbounded' };

/** Thrown when the pivot limit is reached, which Bland's rule makes impossible without a bug. */
export class SimplexSafetyError extends Error {
  public constructor() {
    super('The simplex reached its pivot limit.');
    this.name = 'SimplexSafetyError';
  }
}

// A pivot element smaller than this is treated as zero.
const PIVOT_TOLERANCE = 1e-9;
// Relative to the size of the right-hand sides; a phase-one optimum above it proves infeasibility.
const FEASIBILITY_TOLERANCE = 1e-9;
// Relative to the size of the objective; a reduced cost above minus this is not an improvement.
const COST_TOLERANCE = 1e-11;
const MAX_PIVOTS = 100_000;

function flipped(relation: LinearConstraint['relation']): LinearConstraint['relation'] {
  if (relation === '<=') return '>=';
  if (relation === '>=') return '<=';
  return '=';
}

export function solveLinearProgram(program: LinearProgram): LinearSolution {
  const variables = program.objective.length;
  const rows = program.constraints.map((constraint) =>
    constraint.value < 0
      ? {
          coefficients: constraint.coefficients.map((value) => -value),
          relation: flipped(constraint.relation),
          value: -constraint.value,
        }
      : constraint,
  );
  const slacks = rows.filter((row) => row.relation !== '=').length;
  const artificialStart = variables + slacks;
  const width = artificialStart + rows.filter((row) => row.relation !== '<=').length;
  const table: number[][] = [];
  const basis: number[] = [];
  let nextSlack = variables;
  let nextArtificial = artificialStart;
  for (const row of rows) {
    const line = new Array<number>(width + 1).fill(0);
    row.coefficients.forEach((value, column) => {
      if (column < variables) line[column] = value;
    });
    line[width] = row.value;
    if (row.relation === '<=') {
      line[nextSlack] = 1;
      basis.push(nextSlack);
      nextSlack += 1;
    } else {
      if (row.relation === '>=') {
        line[nextSlack] = -1;
        nextSlack += 1;
      }
      line[nextArtificial] = 1;
      basis.push(nextArtificial);
      nextArtificial += 1;
    }
    table.push(line);
  }
  const rhsScale = 1 + rows.reduce((sum, row) => sum + Math.abs(row.value), 0);
  let pivots = 0;

  const pivot = (objective: number[], row: number, column: number) => {
    pivots += 1;
    if (pivots > MAX_PIVOTS) throw new SimplexSafetyError();
    const line = table[row] ?? [];
    const element = line[column] ?? 1;
    for (let index = 0; index <= width; index += 1) line[index] = (line[index] ?? 0) / element;
    line[column] = 1;
    for (const other of [...table, objective]) {
      if (other === line) continue;
      const factor = other[column] ?? 0;
      if (factor === 0) continue;
      for (let index = 0; index <= width; index += 1) {
        other[index] = (other[index] ?? 0) - factor * (line[index] ?? 0);
      }
      other[column] = 0;
    }
    basis[row] = column;
  };

  // Reduced costs of `cost`, with minus the objective value in the last column.
  const reduced = (cost: readonly number[]) => {
    const objective = new Array<number>(width + 1).fill(0);
    cost.forEach((value, column) => {
      objective[column] = value;
    });
    table.forEach((line, row) => {
      const weight = cost[basis[row] ?? 0] ?? 0;
      if (weight === 0) return;
      for (let index = 0; index <= width; index += 1) {
        objective[index] = (objective[index] ?? 0) - weight * (line[index] ?? 0);
      }
    });
    return objective;
  };

  const optimise = (cost: readonly number[], columns: number): 'optimal' | 'unbounded' => {
    const objective = reduced(cost);
    const tolerance = COST_TOLERANCE * (1 + Math.max(0, ...cost.map(Math.abs)));
    for (;;) {
      let entering = -1;
      for (let column = 0; column < columns; column += 1) {
        if ((objective[column] ?? 0) < -tolerance) {
          entering = column;
          break;
        }
      }
      if (entering === -1) return 'optimal';
      let leaving = -1;
      let best = Number.POSITIVE_INFINITY;
      table.forEach((line, row) => {
        const element = line[entering] ?? 0;
        if (element <= PIVOT_TOLERANCE) return;
        const ratio = Math.max(0, line[width] ?? 0) / element;
        const tie = 1e-12 * (1 + ratio);
        if (
          leaving === -1 ||
          ratio < best - tie ||
          (ratio <= best + tie && (basis[row] ?? 0) < (basis[leaving] ?? 0))
        ) {
          best = leaving === -1 ? ratio : Math.min(best, ratio);
          leaving = row;
        }
      });
      if (leaving === -1) return 'unbounded';
      pivot(objective, leaving, entering);
    }
  };

  // Phase one: minimise the artificial variables.
  if (width > artificialStart) {
    const cost = new Array<number>(width).fill(0);
    for (let column = artificialStart; column < width; column += 1) cost[column] = 1;
    optimise(cost, width);
    const shortfall = table.reduce(
      (sum, line, row) => sum + ((basis[row] ?? 0) >= artificialStart ? (line[width] ?? 0) : 0),
      0,
    );
    if (shortfall > FEASIBILITY_TOLERANCE * rhsScale) return { shortfall, status: 'infeasible' };
    // Drive the artificial variables left in the basis (at zero) out, or drop their rows.
    const scratch = new Array<number>(width + 1).fill(0);
    for (let row = table.length - 1; row >= 0; row -= 1) {
      if ((basis[row] ?? 0) < artificialStart) continue;
      const line = table[row] ?? [];
      let column = 0;
      while (column < artificialStart && Math.abs(line[column] ?? 0) <= PIVOT_TOLERANCE)
        column += 1;
      if (column < artificialStart) {
        pivot(scratch, row, column);
      } else {
        table.splice(row, 1);
        basis.splice(row, 1);
      }
    }
  }

  // Phase two on the original objective; artificial columns never re-enter.
  if (optimise(program.objective, artificialStart) === 'unbounded') return { status: 'unbounded' };
  const x = new Array<number>(variables).fill(0);
  table.forEach((line, row) => {
    const column = basis[row] ?? 0;
    if (column < variables) x[column] = Math.max(0, line[width] ?? 0);
  });
  const value = program.objective.reduce(
    (sum, weight, column) => sum + weight * (x[column] ?? 0),
    0,
  );
  return { status: 'optimal', value, x };
}
