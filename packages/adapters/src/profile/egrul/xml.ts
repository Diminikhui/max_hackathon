// K-12a. Минимальный разбор XML выгрузок ФНС (ЕГРЮЛ/ЕГРИП): элементы, атрибуты, текст.
// Выгрузки ФНС почти целиком на атрибутах, поэтому полноценный XML-парсер не нужен.
// DTD, пространства имён и CDATA не поддерживаются: их нет в форматах 4.0x.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(ENTITY, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return NAMED[lower] ?? "";
  });
}

/** Разбирает документ и возвращает корневой элемент. Бросает `Error` на несбалансированных тегах. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  for (const match of xml.matchAll(TOKEN)) {
    const [, closing, name, rawAttrs, selfClosing, text] = match;
    const current = stack[stack.length - 1] as XmlElement;
    if (text !== undefined) {
      if (text.trim()) current.text += decode(text);
      continue;
    }
    if (name === undefined) continue; // комментарий или объявление
    if (closing) {
      if (current.name !== name) throw new Error(`XML: ожидался </${current.name}>, получен </${name}>`);
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of (rawAttrs ?? "").matchAll(ATTR)) {
      attrs[attr[1] as string] = decode(attr[2] ?? attr[3] ?? "");
    }
    const element: XmlElement = { name, attrs, children: [], text: "" };
    current.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1) throw new Error(`XML: не закрыт элемент <${(stack[stack.length - 1] as XmlElement).name}>`);
  const [first] = root.children;
  if (!first || root.children.length !== 1) throw new Error("XML: ожидался ровно один корневой элемент");
  return first;
}

export function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((c) => c.name === name);
}

export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((c) => c.name === name);
}
