import { CellList, CellSimple, Container, Flex, Typography } from "@maxhub/max-ui";
import type { ComponentType } from "react";
import { ChecklistScreen } from "../../checklist";
import { useApp } from "./AppContext";
import type { ScreenId } from "./navigation";

export interface ScreenDefinition {
  readonly title: string;
  readonly component: ComponentType;
}

export type ScreenRegistry = Readonly<Record<ScreenId, ScreenDefinition>>;

function HomeScreen() {
  const { push } = useApp();
  return (
    <CellList mode="island" filled>
      <CellSimple
        title="Профиль компании"
        subtitle="Сведения, по которым подбираются требования"
        showChevron
        onClick={() => push({ screen: "profile" })}
      />
      <CellSimple
        title="Перечень требований"
        subtitle="Что относится к компании и почему"
        showChevron
        onClick={() => push({ screen: "checklist" })}
      />
      <CellSimple
        title="Уведомления"
        subtitle="Частота и категории"
        showChevron
        onClick={() => push({ screen: "settings" })}
      />
    </CellList>
  );
}

/** Заглушка экрана, который ещё не реализован своим потоком. */
function placeholder(stream: string): ComponentType {
  return function PlaceholderScreen() {
    return (
      <Container className="app-shell__section">
        <Flex direction="column" gap={8}>
          <Typography.Body>Экран в разработке.</Typography.Body>
          <Typography.Label>Появится в потоке {stream}.</Typography.Label>
        </Flex>
      </Container>
    );
  };
}

/** Реестр экранов. Экранные потоки заменяют заглушку своим компонентом. */
export const SCREENS: ScreenRegistry = {
  home: { title: "Проверка требований", component: HomeScreen },
  profile: { title: "Профиль компании", component: placeholder("2-02") },
  checklist: { title: "Перечень требований", component: ChecklistScreen },
  settings: { title: "Уведомления", component: placeholder("2-05") },
};
