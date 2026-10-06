import { describe, expect, it } from "vitest";
import { classifyConfirmation } from "@/server/agenda/selection";

/**
 * Rendimiento de `classifyConfirmation` (todas sus expresiones regulares) con
 * entradas adversas de 1k, 16k y 100k caracteres. Debe crecer en forma lineal:
 * se reporta el tiempo y se exige un techo amplio para no volverse frágil.
 */

const ADVERSARIAL: Record<string, (n: number) => string> = {
  si_espacios: (n) => "si" + " ".repeat(n - 2),
  si_repetido: (n) => "si ".repeat(Math.ceil(n / 3)).slice(0, n),
  claro_que: (n) => "claro que ".repeat(Math.ceil(n / 10)).slice(0, n),
  de_acuerdo: (n) => "de ".repeat(Math.ceil(n / 3)).slice(0, n),
  pulgares: (n) => "👍".repeat(Math.ceil(n / 2)).slice(0, n),
  pulgares_tono: (n) => "👍🏽 ".repeat(Math.ceil(n / 5)).slice(0, n),
  signos: (n) => "¿?".repeat(Math.ceil(n / 2)).slice(0, n),
  digitos: (n) => "si 1".repeat(Math.ceil(n / 4)).slice(0, n),
  acentos: (n) => "sí ".repeat(Math.ceil(n / 3)).slice(0, n),
  puntuacion: (n) => "si,!.;".repeat(Math.ceil(n / 6)).slice(0, n),
};

function time(text: string): number {
  const reps = text.length <= 1_000 ? 50 : text.length <= 16_000 ? 10 : 3;
  classifyConfirmation(text);
  const t0 = performance.now();
  for (let i = 0; i < reps; i += 1) classifyConfirmation(text);
  return (performance.now() - t0) / reps;
}

describe("rendimiento de classifyConfirmation", () => {
  it("1k / 16k / 100k caracteres adversos: lineal y bajo el techo", () => {
    const rows: string[] = [];
    for (const [name, gen] of Object.entries(ADVERSARIAL)) {
      const [a, b, c] = [1_000, 16_000, 100_000].map((n) => time(gen(n)));
      rows.push(
        `${name.padEnd(14)} 1k=${a!.toFixed(3)}ms 16k=${b!.toFixed(3)}ms 100k=${c!.toFixed(2)}ms 100k/16k=${(c! / Math.max(b!, 1e-3)).toFixed(1)}`
      );
      expect(c!, name).toBeLessThan(250);
    }
    console.log(rows.join("\n"));
  });
});
