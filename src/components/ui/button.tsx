import * as React from "react";
import { cn } from "@/lib/utils";

const VARIANTS = {
  default: "bg-neutral-900 text-white hover:bg-neutral-800",
  outline: "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100",
  ghost: "text-neutral-700 hover:bg-neutral-200",
} as const;

const SIZES = {
  default: "h-9 px-4 py-2 text-sm",
  sm: "h-8 px-3 text-sm",
  icon: "h-9 w-9",
} as const;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
}

/** Minimal shadcn-style button: variants + sizes composed through `cn`. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
