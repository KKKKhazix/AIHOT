import { useRef, type InputHTMLAttributes } from "react";
import { useT } from "../../lib/i18n";
import { IconClose, IconSearch } from "../icons";
import { Presence } from "./Presence";

type Props = Pick<InputHTMLAttributes<HTMLInputElement>, "aria-label" | "placeholder" | "list" | "maxLength" | "type"> & {
  value: string;
  onChange: (value: string) => void;
  className: string;
  inputClassName?: string;
};

export function FilterSearch({ value, onChange, className, inputClassName = "", ...input }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const t = useT();
  return (
    <div className={`group relative ${className}`}>
      <IconSearch size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4 transition-colors group-focus-within:text-ink-3 lg:left-3" />
      <input {...input} ref={ref} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" enterKeyHint="search"
        className={`h-11 w-full rounded-full bg-well pl-9 pr-11 text-ui-body-lg text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent lg:h-8 lg:pl-8 lg:pr-8 lg:text-ui-label touch:h-11 touch:pr-11 ${inputClassName}`} />
      <Presence show={!!value} motion="fade">
        <button type="button" aria-label={t("清空", "Clear")} onClick={() => { onChange(""); ref.current?.focus(); }}
          className="group/clear absolute right-0 top-1/2 grid size-11 -translate-y-1/2 place-items-center text-ink-4 lg:right-1 lg:size-6 touch:right-0 touch:size-11">
          <span className="grid size-6 place-items-center rounded-full transition-colors group-hover/clear:bg-bg-sunk group-hover/clear:text-ink">
            <IconClose size={13} />
          </span>
        </button>
      </Presence>
    </div>
  );
}
