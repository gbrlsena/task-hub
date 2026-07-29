import { describe, expect, it } from "vitest";
import { stickerHeight } from "./sticker";

describe("stickerHeight", () => {
  it("cola na altura do conteúdo", () => {
    expect(stickerHeight(420, 1080)).toBe(420);
  });

  it("não encolhe além do mínimo", () => {
    expect(stickerHeight(40, 1080)).toBe(160);
  });

  it("não passa de 90% da tela", () => {
    expect(stickerHeight(3000, 1000)).toBe(900);
  });

  it("arredonda pra cima pra não cortar a última linha", () => {
    expect(stickerHeight(420.2, 1080)).toBe(421);
  });

  it("tolera tela absurdamente baixa sem inverter os limites", () => {
    expect(stickerHeight(500, 100)).toBe(160);
  });
});
