import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTranslator, detectInitialLanguage, isLanguage, normalizeLanguage } from "./core.ts";
import { dictionaries } from "./messages.ts";

describe("i18n core", () => {
  it("keeps a supported saved language", () => {
    assert.equal(detectInitialLanguage("en"), "en");
  });

  it("always resolves to English, including for non-English system locales", () => {
    assert.equal(detectInitialLanguage(null), "en");
    assert.equal(detectInitialLanguage("zh"), "en");
  });

  it("normalizes unsupported saved values", () => {
    assert.equal(normalizeLanguage("de"), null);
    assert.equal(normalizeLanguage("zh"), null);
    assert.equal(isLanguage("en"), true);
    assert.equal(isLanguage("zh"), false);
  });

  it("translates known keys and interpolates variables", () => {
    const t = createTranslator("en", dictionaries);
    assert.equal(t("app.title"), "License Manager");
    assert.equal(t("messages.generatedCodes", { count: 3 }), "Generated 3 activation codes");
  });

  it("falls back to the raw key for unknown translations", () => {
    const t = createTranslator("en", dictionaries);
    assert.equal(t("does.not.exist"), "does.not.exist");
  });
});
