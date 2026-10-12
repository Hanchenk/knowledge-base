"""Row-aware XLSX extraction; cached values only, never execute formulas."""
import calendar
import datetime
import re
from collections import defaultdict


def clean(value):
    return re.sub(r"\s+", " ", str(value)).strip() if value is not None else ""


def display(cell, label=""):
    value = cell.value
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        if "%" in cell.number_format or label.endswith("/%"):
            return f"{value * 100:.4f}".rstrip("0").rstrip(".") + "%"
        return f"{value:.10f}".rstrip("0").rstrip(".")
    return clean(value).replace("|", "\\|")


def sheet_date(rows):
    # Prefer the explicit report date near the top, never dates in incident notes.
    for row in rows[:6]:
        for index, cell in enumerate(row):
            value = cell.value
            labelled = index > 0 and clean(row[index - 1].value).rstrip("：:") in {"日期", "报告日期"}
            if labelled and isinstance(value, (datetime.date, datetime.datetime)):
                return value.date() if isinstance(value, datetime.datetime) else value
            text = clean(value)
            if re.search(r"日期\s*[：:]", text) or labelled:
                match = re.search(r"(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})", text)
                if match:
                    try:
                        return datetime.date(*map(int, match.groups()))
                    except ValueError:
                        pass
    return None


def extract_workbook(book):
    records = []
    observations = defaultdict(dict)
    for page, sheet in enumerate(book, 1):
        if sheet.title.startswith("WpsReserved_"):
            continue
        if sheet.max_row > 50_000 or sheet.max_column > 512:
            raise ValueError("Spreadsheet exceeds 50,000 rows or 512 columns")
        rows = list(sheet.iter_rows())
        start = len(records)
        structured_data = False
        date = sheet_date(rows)
        context = f"工作表：{sheet.title}" + (f"；日期：{date.isoformat()}" if date else "")
        title = next((clean(c.value) for row in rows[:1] for c in row if c.value), "")
        labels, pending, section = [], [], ""
        known_units = {}
        # Merged group headings (e.g. loss type) apply to every child column.
        merged = {}
        for area in sheet.merged_cells.ranges:
            if area.min_row == area.max_row:
                value = clean(sheet.cell(area.min_row, area.min_col).value)
                for col in range(area.min_col, area.max_col + 1):
                    merged[(area.min_row, col)] = value
        for row in rows:
            cells = [c for c in row if c.value is not None]
            if not cells:
                continue
            numbers = [c for c in cells if isinstance(c.value, (float, int)) and not isinstance(c.value, bool)]
            header = len(cells) >= 2 and not numbers and not any(re.search(r"日期\s*[：:]", clean(c.value)) for c in cells)
            if header:
                if not pending:
                    labels = []
                pending.append(row)
                labels = []
                for col in range(1, len(row) + 1):
                    parts = []
                    for h in pending:
                        part = merged.get((h[0].row, col), clean(h[col - 1].value))
                        if part and part not in parts:
                            parts.append(part)
                    label = "/".join(parts) or f"列{col}"
                    # Repeated sections can omit a unit row. Reuse only units
                    # explicitly observed for the same heading AND column.
                    if len(parts) == 2 and parts[-1] in {"万度", "MW", "%", "h", "MJ/㎡", "m/s"}:
                        known_units[(col, parts[0])] = parts[-1]
                    elif len(parts) == 1 and (col, parts[0]) in known_units:
                        label += "/" + known_units[(col, parts[0])]
                    labels.append(label)
                section = clean(pending[0][0].value)
                records.append({"text": f"{context}；表头行：{row[0].row}\n" + " | ".join(clean(c.value) for c in row).rstrip(" |"), "page": page, "kind": "table_header"})
                continue
            pending = []
            # Preserve simple/headerless tables as complete original rows.
            if not labels or not numbers:
                values = [display(c) for c in row]
                while values and not values[-1]:
                    values.pop()
                records.append({"text": f"{context}；行：{row[0].row}\n" + " | ".join(values), "page": page, "kind": "table"})
                continue
            name = clean(row[0].value)
            structured_data = True
            fields = [(labels[i], display(c, labels[i])) for i, c in enumerate(row) if c.value is not None and i < len(labels)]
            text = f"{title}\n{context}；表区：{section or '数据'}；行：{row[0].row}\n"
            text += "\n\n" + "\n".join(f"- {label}：{value}" for label, value in fields)
            records.append({"text": text, "page": page, "kind": "table"})
            # Monthly summaries require explicitly dated daily reports and
            # explicitly named monthly measures; arbitrary sheets stay rows.
            monthly = {label: value for label, value in fields[1:] if label.startswith("月")}
            if date and name and monthly:
                key = (date.year, date.month, name)
                if date in observations[key]:
                    # Ambiguous duplicate rows on one date must not be silently merged.
                    observations[key][date] = None
                else:
                    observations[key][date] = (monthly, page, row[0].row)
        if structured_data:
            # Each data row already repeats its headings. Standalone headings
            # otherwise outrank real values because their text is very short.
            records[start:] = [r for r in records[start:] if r["kind"] != "table_header"]
        else:
            for record in records[start:]:
                record["kind"] = "table"
    by_month = defaultdict(list)
    for (year, month, name), daily in observations.items():
        latest = max(daily)
        entry = daily[latest]
        if entry is None:
            continue
        fields, page, row = entry
        by_month[(year, month)].append((name, latest, fields, page, row, sum(v is not None for v in daily.values())))
    summaries = []
    for (year, month), stations in by_month.items():
        # A compact primary table covers every station, including group totals.
        primary = ["月发电量", "月供电量", "月预算电量", "月预算完成率", "月结算电量"]
        columns = list(dict.fromkeys(label for _, _, fields, _, _, _ in stations for label in fields if label.split("/")[0] in primary))
        if not columns:
            continue
        last = max(v[1] for v in stations)
        days = calendar.monthrange(year, month)[1]
        text = f"{year}年{month}月各场站日报数据汇总（月累计快照）\n"
        text += f"口径：逐场站取本月最后一份可用日报中的月累计值，截至 {last.isoformat()}。月累计不得按天求和；合计行不得与分站重复累加。空值/斜杠表示未提供，不能当作零。\n"
        text += f"本月应有 {days} 天；覆盖天数按该场站有记录的不同日期计数，覆盖不足时不能声称逐日日报全覆盖。月末累计与逐日明细覆盖是不同口径。保留原表名称，不合并疑似错别字。\n\n"
        headers = ["场站/原表合计", *columns, "截至日期", "覆盖天数", "来源工作表/行"]
        text += "| " + " | ".join(headers) + " |\n| " + " | ".join(["---"] * len(headers)) + " |\n"
        for name, date, fields, page, row, count in stations:
            text += "| " + " | ".join([name, *[fields.get(c, "未提供") for c in columns], date.isoformat(), f"{count}/{days}", f"{book.worksheets[page - 1].title}/{row}"]) + " |\n"
        if len(text) > 24_000:
            raise ValueError("Monthly summary exceeds 24,000 characters; split the workbook")
        summaries.append({"text": text, "page": next(v[3] for v in stations if v[1] == last), "kind": "table_summary"})
    return summaries + records
