import { describe, expect, it } from "vitest";
import { type MaxWebApp, readLaunchContext } from "../src/core/bridge.js";
import { HOME, initialStack, type NavigationStack, navigationReducer } from "../src/core/navigation.js";

const noopBackButton = { show() {}, hide() {}, onClick() {}, offClick() {} };

// Модельные значения Bridge: настоящий initData не используется.
const modelBridge = (overrides: Partial<MaxWebApp> = {}): MaxWebApp => ({
  initData: "query_id=model&auth_date=1&hash=model",
  platform: "ios",
  ...overrides,
});

describe("readLaunchContext", () => {
  it("вне MAX: нет Bridge — модельный режим", () => {
    const launch = readLaunchContext(undefined);
    expect(launch.inMax).toBe(false);
    expect(launch.platform).toBeUndefined();
    expect(launch.uiPlatform).toBeUndefined();
  });

  it("Bridge без initData не считается запуском из MAX", () => {
    expect(readLaunchContext(modelBridge({ initData: "" })).inMax).toBe(false);
  });

  it("скрипт Bridge вне клиента MAX: поля null, Bridge не используется", () => {
    const launch = readLaunchContext({
      initData: null,
      initDataUnsafe: null,
      platform: null,
      BackButton: noopBackButton,
    });
    expect(launch).toMatchObject({ inMax: false, bridge: undefined, platform: undefined, startParam: undefined });
  });

  it("платформа MAX переводится в платформу MAX UI", () => {
    expect(readLaunchContext(modelBridge({ platform: "android" })).uiPlatform).toBe("android");
    expect(readLaunchContext(modelBridge({ platform: "web" }))).toMatchObject({
      inMax: true,
      platform: "web",
      uiPlatform: undefined,
    });
    expect(readLaunchContext(modelBridge({ platform: "tv" })).platform).toBeUndefined();
  });

  it("start_param принимается только в формате deep link MAX", () => {
    const withParam = (start_param: string) => readLaunchContext(modelBridge({ initDataUnsafe: { start_param } }));
    expect(withParam("checklist").startParam).toBe("checklist");
    expect(withParam("case_42-a").startParam).toBe("case_42-a");
    expect(withParam("bad param").startParam).toBeUndefined();
    expect(withParam("x".repeat(513)).startParam).toBeUndefined();
  });
});

describe("navigationReducer", () => {
  const start: NavigationStack = [HOME];

  it("push и back", () => {
    const opened = navigationReducer(start, { type: "push", route: { screen: "profile" } });
    expect(opened).toEqual([HOME, { screen: "profile" }]);
    expect(navigationReducer(opened, { type: "back" })).toEqual([HOME]);
  });

  it("back на главном экране ничего не делает", () => {
    expect(navigationReducer(start, { type: "back" })).toBe(start);
  });

  it("повторный push того же экрана не растит стек", () => {
    const route = { screen: "checklist", params: { id: "r1" } } as const;
    const once = navigationReducer(start, { type: "push", route });
    expect(navigationReducer(once, { type: "push", route: { ...route, params: { id: "r1" } } })).toBe(once);
    expect(navigationReducer(once, { type: "push", route: { ...route, params: { id: "r2" } } })).toHaveLength(3);
  });

  it("reset оставляет главный экран под целевым", () => {
    const deep = navigationReducer(navigationReducer(start, { type: "push", route: { screen: "profile" } }), {
      type: "push",
      route: { screen: "settings" },
    });
    expect(navigationReducer(deep, { type: "reset", route: { screen: "checklist" } })).toEqual([
      HOME,
      { screen: "checklist" },
    ]);
    expect(navigationReducer(deep, { type: "reset", route: HOME })).toEqual([HOME]);
  });
});

describe("initialStack", () => {
  it("открывает экран из deep link, иначе главный", () => {
    expect(initialStack("settings")).toEqual([HOME, { screen: "settings" }]);
    expect(initialStack("unknown")).toEqual([HOME]);
    expect(initialStack(undefined)).toEqual([HOME]);
  });

  it("открывает карточку требования из непрозрачного deep link", () => {
    expect(initialStack("requirement_6b32382e77617465722d6d61726b696e67")).toEqual([
      HOME,
      { screen: "checklist", params: { requirementId: "k28.water-marking" } },
    ]);
    expect(initialStack("requirement_bad")).toEqual([HOME]);
  });
});
