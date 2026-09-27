// Минимальный разбор XML для ответа /api/npalist/: элементы, атрибуты, текст, CDATA, сущности.
// DTD и пространства имён не поддерживаются — в ответе портала их нет; внешние сущности не раскрываются.

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Текст элемента без вложенных элементов, обрезанный по краям. */
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string, position: number) {
    super(`${message} (позиция ${position})`);
    this.name = "XmlParseError";
  }
}

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x")) return safeCodePoint(Number.parseInt(entity.slice(2), 16)) ?? match;
    if (entity.startsWith("#")) return safeCodePoint(Number.parseInt(entity.slice(1), 10)) ?? match;
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function safeCodePoint(code: number): string | undefined {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

const NAME = /[A-Za-z_:][\w.:-]*/y;
const ATTRIBUTE = /\s+([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/** Разбирает документ и возвращает корневой элемент. */
export function parseXml(source: string): XmlElement {
  let pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: { element: XmlElement; textParts: string[] }[] = [];
  let root: XmlElement | undefined;

  const skip = (open: string, close: string): void => {
    const end = source.indexOf(close, pos + open.length);
    if (end < 0) throw new XmlParseError(`Не закрыт блок ${open}`, pos);
    pos = end + close.length;
  };

  while (pos < source.length) {
    const lt = source.indexOf("<", pos);
    const textEnd = lt < 0 ? source.length : lt;
    if (textEnd > pos) {
      const raw = source.slice(pos, textEnd);
      const top = stack.at(-1);
      if (top) top.textParts.push(decodeEntities(raw));
      else if (raw.trim()) throw new XmlParseError("Текст вне корневого элемента", pos);
      pos = textEnd;
    }
    if (lt < 0) break;

    if (source.startsWith("<?", pos)) skip("<?", "?>");
    else if (source.startsWith("<!--", pos)) skip("<!--", "-->");
    else if (source.startsWith("<![CDATA[", pos)) {
      const end = source.indexOf("]]>", pos);
      if (end < 0) throw new XmlParseError("Не закрыт CDATA", pos);
      stack.at(-1)?.textParts.push(source.slice(pos + 9, end));
      pos = end + 3;
    } else if (source.startsWith("<!", pos)) {
      throw new XmlParseError("DTD не поддерживается", pos);
    } else if (source.startsWith("</", pos)) {
      NAME.lastIndex = pos + 2;
      const name = NAME.exec(source)?.[0];
      const top = stack.pop();
      if (!name || !top || top.element.name !== name) {
        throw new XmlParseError(`Неожиданный закрывающий тег </${name ?? ""}>`, pos);
      }
      top.element.text = top.textParts.join("").trim();
      const end = source.indexOf(">", pos);
      if (end < 0) throw new XmlParseError("Не закрыт тег", pos);
      pos = end + 1;
    } else {
      NAME.lastIndex = pos + 1;
      const name = NAME.exec(source)?.[0];
      if (!name) throw new XmlParseError("Ожидалось имя тега", pos);
      pos = NAME.lastIndex;
      const attributes: Record<string, string> = {};
      for (;;) {
        ATTRIBUTE.lastIndex = pos;
        const match = ATTRIBUTE.exec(source);
        if (!match) break;
        attributes[match[1] as string] = decodeEntities(match[2] ?? match[3] ?? "");
        pos = ATTRIBUTE.lastIndex;
      }
      while (/\s/.test(source[pos] ?? "")) pos++;
      const selfClosing = source.startsWith("/>", pos);
      if (!selfClosing && source[pos] !== ">") throw new XmlParseError(`Неверный тег <${name}>`, pos);
      pos += selfClosing ? 2 : 1;

      const element: XmlElement = { name, attributes, children: [], text: "" };
      const parent = stack.at(-1);
      if (parent) parent.element.children.push(element);
      else if (root) throw new XmlParseError("Больше одного корневого элемента", pos);
      else root = element;
      if (!selfClosing) stack.push({ element, textParts: [] });
    }
  }

  if (stack.length > 0) throw new XmlParseError(`Не закрыт элемент <${stack.at(-1)?.element.name}>`, pos);
  if (!root) throw new XmlParseError("Пустой документ", pos);
  return root;
}
