import { DatePicker, Grid, Input } from 'antd';
import dayjs from 'dayjs';
export function DateRangeFilter({
  value,
  onChange,
}: {
  value?: [string, string];
  onChange?: (value: [string, string] | undefined) => void;
}) {
  const mobile = !Grid.useBreakpoint().lg;
  if (mobile)
    return (
      <div className="mobile-date-range" role="group" aria-label="日期范围">
        <Input
          type="date"
          aria-label="开始日期"
          value={value?.[0] ?? ''}
          onChange={(event) =>
            onChange?.(
              event.target.value
                ? [event.target.value, value?.[1] ?? event.target.value]
                : undefined,
            )
          }
        />
        <span>至</span>
        <Input
          type="date"
          aria-label="结束日期"
          min={value?.[0]}
          value={value?.[1] ?? ''}
          onChange={(event) =>
            onChange?.(
              event.target.value
                ? [value?.[0] ?? event.target.value, event.target.value]
                : undefined,
            )
          }
        />
      </div>
    );
  return (
    <DatePicker.RangePicker
      aria-label="日期范围"
      value={value ? [dayjs(value[0]), dayjs(value[1])] : null}
      onChange={(dates) =>
        onChange?.(
          dates?.[0] && dates[1]
            ? [dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]
            : undefined,
        )
      }
    />
  );
}
