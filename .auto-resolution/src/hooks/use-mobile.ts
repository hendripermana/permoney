import * as React from "react"

import { useMountEffect } from "@/hooks/use-mount-effect"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  // Browser API subscription with stable (`[]`) deps — canonical
  // `useMountEffect` use case per the no-use-effect convention.
  // We sync to `matchMedia` once on mount, push the initial value, and
  // tear down the listener on unmount. No prop dependency.
  useMountEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  })

  return !!isMobile
}
