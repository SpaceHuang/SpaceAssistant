export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function scrollBehaviorPreference(preferred: ScrollBehavior = 'smooth'): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : preferred
}

export function scrollIntoViewWithMotionPreference(
  element: Element,
  options: Omit<ScrollIntoViewOptions, 'behavior'> & { behavior?: ScrollBehavior } = {}
): void {
  const { behavior: preferred = 'smooth', ...rest } = options
  element.scrollIntoView({ ...rest, behavior: scrollBehaviorPreference(preferred) })
}
