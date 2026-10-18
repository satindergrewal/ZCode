import { describe, expectTypeOf, it } from "vitest";
import type {
  ModelInputFormatData,
  ModelOutputFormatData,
  ModelPropertiesData,
  EnumOptionSpecData,
  LimitOptionSpecData,
  ModelOptionSpecsData,
} from "@zcode/shared/model-config";
import type {
  ModelInputFormat,
  ModelOutputFormat,
  ModelProperties,
  EnumOptionSpec,
  LimitOptionSpec,
  ModelOptionSpecs,
} from "../src/model/model.js";

describe("CLI vs shared model schema data contract", () => {
  it("all model data types match both ways; no parallel field list in the CLI", () => {
    expectTypeOf<ModelInputFormat>().toEqualTypeOf<ModelInputFormatData>();
    expectTypeOf<ModelOutputFormat>().toEqualTypeOf<ModelOutputFormatData>();
    expectTypeOf<ModelProperties>().toEqualTypeOf<ModelPropertiesData>();
    expectTypeOf<EnumOptionSpec>().toEqualTypeOf<EnumOptionSpecData>();
    expectTypeOf<LimitOptionSpec>().toEqualTypeOf<LimitOptionSpecData>();
    expectTypeOf<ModelOptionSpecs>().toEqualTypeOf<ModelOptionSpecsData>();
  });
});
