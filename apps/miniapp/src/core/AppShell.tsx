import { Button, Flex, MaxUI, Panel, Typography } from "@maxhub/max-ui";
import { AppProvider, useApp } from "./AppContext";
import type { LaunchContext } from "./bridge";
import type { ScreenRegistry } from "./screens";

/** Корень мини-приложения: тема и платформа MAX UI, навигация и Bridge. */
export function AppShell({ launch, screens }: { launch: LaunchContext; screens: ScreenRegistry }) {
  return (
    // Тему (светлая/тёмная) MAX UI берёт из системной: Bridge её не передаёт.
    <MaxUI platform={launch.uiPlatform}>
      <AppProvider launch={launch}>
        <Screen screens={screens} />
      </AppProvider>
    </MaxUI>
  );
}

function Screen({ screens }: { screens: ScreenRegistry }) {
  const { route, canGoBack, back, launch } = useApp();
  const { title, component: Content } = screens[route.screen];
  // В MAX «Назад» — системная кнопка клиента; вне MAX показываем свою.
  const showOwnBack = canGoBack && !launch.bridge?.BackButton;

  return (
    <Panel mode="secondary" className="app-shell">
      <div className="app-shell__content">
        {!launch.inMax && (
          <div className="app-shell__model-banner" role="note">
            <Typography.Label>
              Модельный режим: приложение открыто не из MAX, подпись пользователя не проверяется.
            </Typography.Label>
          </div>
        )}
        <Flex align="center" gap={8} className="app-shell__header">
          {showOwnBack && (
            <Button size="small" variant="secondary" onClick={back}>
              Назад
            </Button>
          )}
          <Typography.Title>{title}</Typography.Title>
        </Flex>
        <Content key={route.screen} />
      </div>
    </Panel>
  );
}
