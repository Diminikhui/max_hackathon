# Issue #244: журнал предметной сверки

Дата: 29.09.2026. Файл записей: `foodservice-tax-marking-federal-v1.json`.
Все записи имеют `coverage: partial`: сведения о типе лица, товаре и обороте
неизвестны, поэтому пакет не должен уверенно отвечать «применяется».

Ниже — короткие дословные выдержки из **разъяснений ФНС, СФР и оператора
маркировки**. Это подтверждение отдельных формулировок, а не дословная сверка
полного текста закона. Официальные адреса актов стоят в `basis` записей.
ИПС `pravo.gov.ru/proxy/ips` из окружения 29.09.2026 не открылась. До
публикации пакета нужен просмотр действующих редакций каждого акта поле в поле.

| ID | Дословная выдержка из официального разъяснения | Дополнительно проверить |
|---|---|---|
| `usn-annual-declaration` | «Организации - не позднее 25 марта года, следующего за истекшим налоговым периодом» — [ФНС](https://www.nalog.gov.ru/rn77/taxation/taxes/usn/) | НК ст. 346.23, прекращение и утрата права |
| `usn-advances-notification` | «Не позднее 28 календарных дней со дня окончания отчетного периода» — [ФНС](https://www.nalog.gov.ru/rn77/taxation/taxes/usn/) | НК ст. 58 п. 9, ст. 346.21; исключения уведомлений |
| `ausn-monthly-tax` | «Декларация по налогу в связи с применением АвтоУСН в налоговые органы не представляется» — [ФНС](https://www.nalog.gov.ru/rn77/taxation/taxes/autotax_system/) | 17-ФЗ ст. 12–13; региональный закон |
| `psn-application-payment` | «Заявление на получение патента необходимо подать не позднее чем за 10 дней» — [ФНС](https://www.nalog.gov.ru/rn23/taxation/taxes/patent/) | НК ст. 346.43, 346.45, 346.51–52; закон региона |
| `npd-receipts-tax` | «Налоговая декларация по налогу в налоговые органы не представляется» — [ФНС](https://www.nalog.gov.ru/rn77/taxation/princtax/); [о чеках](https://npd.nalog.ru/faq/) | 422-ФЗ ст. 4, 13–14; перепродажа и исключения |
| `ens-advance-notification` | [ФНС, порядок ЕНС и уведомлений](https://www.nalog.gov.ru/rn77/ens/) | НК ст. 58 п. 9; уведомление требуется не при каждом платеже |
| `employer-6-ndfl` | [ФНС, НДФЛ за работников](https://www.nalog.gov.ru/rn77/ip/ip_pay_taxes/ndfl_people/) | НК ст. 230 п. 2; исключение АУСН |
| `employer-rsv` | «Расчеты по страховым взносам ... ежеквартально не позднее 25-го числа» — [ФНС](https://www.nalog.gov.ru/rn37/news/activities_fts/16614483/) | НК ст. 431 п. 7; директор без зарплаты; АУСН |
| `employer-personal-data` | «за последний месяц квартала не требуется» — [ФНС](https://www.nalog.gov.ru/rn68/news/activities_fts/16610384/) | НК ст. 431 п. 7; АУСН |
| `employer-efs1` | «не позднее рабочего дня, следующего за днем» — [СФР](https://sfr.gov.ru/employers/lk_insurer/baza_znanij/efs_1) | 27-ФЗ ст. 11, 125-ФЗ ст. 24, приказ СФР № 1462 |
| `ip-fixed-contributions` | «Фиксированная сумма взносов в 2026 году ... 57 390 рублей» — [ФНС](https://www.nalog.gov.ru/rn16/news/tax_doc_news/16617063/) | НК ст. 430–432; периоды освобождения и доход свыше 300 тыс. |
| `usn-vat` | «Порог доходов для освобождения от НДС оценивается как по предыдущему календарному году, так и по текущему» — [ФНС](https://www.nalog.gov.ru/rn77/taxation/taxes/nds_usn/) | НК ст. 145 и 149, [228-ФЗ от 04.07.2026](https://publication.pravo.gov.ru/document/0001202607040017); исключения для общепита |
| `marking-milk` | «подписание УПД обеими сторонами должно происходить в течение 24 часов» — [оператор](https://markirovka.ru/knowledge/tovarnye-gruppy/molochnaya-produkciya/v-kakie-sroki-nuzhno-podat-svedeniya-o-peredache-tovara-moloko) | ПП № 2099 в ред. № 745 от 15.06.2026 |
| `marking-water` | «в срок не более 3 рабочих дней со дня приемки товара» — [оператор](https://markirovka.ru/knowledge/tovarnye-gruppy/upakovannaya-voda/v-kakie-sroki-nuzhno-podat-svedeniya-o-peredache-tovara-v-sistemu-markirovki-chestnyy-znak-voda) | ПП № 841 в ред. № 749 |
| `marking-soft-drinks` | «участник представляет сведения о выводе из оборота в течение 3 рабочих дней» — [оператор](https://markirovka.ru/knowledge/tovarnye-gruppy/bezalcohol-napitki/dalneyshie-deystviya-posle-registratsii-po-bezalkogolnym-napitkam-horeca) | ПП № 887 в ред. № 749; группы напитков |
| `marking-beer-keg` | «не позднее следующего рабочего дня со дня подключения кега» — [оператор](https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/kak-peredat-v-sistemu-informatsiyu-ob-ispolzovanii-kega-dlya-razliva-pivo) | ПП № 2173 в ред. № 746, п. 116 |

**Москва, торговый сбор.** ФНС указывает, что исключительно услуги общепита
не образуют объект торговли ([разъяснение](https://www.nalog.gov.ru/rn77/news/tax_doc_news/6080168/)).
Обязанность для всех кафе Москвы не создана. Отдельная торговля требует
самостоятельного факта и сверки главы 33 НК с Законом Москвы № 62.

**Недостающие факты.** `entity.kind` находится в открытом запросе
[#234](https://github.com/Diminikhui/max_hackathon/issues/234); нет фактов
о закупке четырёх групп маркированных товаров, продаже в заводской упаковке,
доходах для НДС и объекте торговли. Контракт в этом потоке не менялся.
