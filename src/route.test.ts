import { describe, expect, it } from "vitest";
import { parseTaskParam } from "./route";

describe("parseTaskParam", () => {
  it("lê o id quando a janela foi aberta com ?task=", () => {
    expect(parseTaskParam("?task=86abc123")).toBe("86abc123");
  });

  it("devolve null na janela principal (sem query)", () => {
    expect(parseTaskParam("")).toBeNull();
  });

  it("devolve null quando o parâmetro vem vazio", () => {
    expect(parseTaskParam("?task=")).toBeNull();
  });

  it("devolve null quando o parâmetro é só espaço", () => {
    expect(parseTaskParam("?task=%20")).toBeNull();
  });

  it("ignora outros parâmetros", () => {
    expect(parseTaskParam("?foo=1")).toBeNull();
  });
});
