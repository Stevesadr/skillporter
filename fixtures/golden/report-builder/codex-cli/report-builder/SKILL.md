---
name: report-builder
description: Build a standalone HTML report from sales data. Use when the user asks for a sales report, a monthly summary, or a chart of revenue.
allowed-tools: Bash(python:*) Read Write
x-acme-owner: data-platform
---

# Report builder

این مهارت یک گزارش HTML مستقل از داده‌های فروش می‌سازد. خروجی باید بدون اتصال به
شبکه باز شود و همهٔ نمودارها درون فایل جاسازی شده باشند.

## Steps

1. Read the input CSV. If the delimiter is not a comma, ask before guessing.
2. Normalise the column names to `snake_case`. Keep the original header order.
3. Build the report with `scripts/build_report.py`.
4. Check that the output opens without a network connection.

## Context

Report the build provenance in the footer. The current commit is
!`git rev-parse --short HEAD` and the branch is taken from the environment.

If the build fails, reproduce it locally before changing anything:

```!
python scripts/build_report.py --input sample.csv --out /tmp/report.html
```

## References

- [Style guide](references/STYLE.md)
- [Pre-flight checklist](references/nested/checklist.md)

## Notes

اعداد را با جداکنندهٔ هزارگان و دو رقم اعشار نمایش بده. واحد پول را از سرستون
داده‌ها بخوان و هرگز حدس نزن.
