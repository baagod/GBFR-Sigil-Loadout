import { useEffect, useRef, type RefObject } from "react";

/**
 * 用滚轮步进：React 把 wheel 监听器注册为 passive，所以写在 onWheel prop 里的 preventDefault
 * 毫无作用——浏览器照旧滚动，而数值同时也在变。监听器因此必须是原生的，并以 passive: false 添加。
 *
 * 一次注册要读到渲染中途才有的最新数值，所以两个回调放在 latest-props ref 里而不是写进依赖
 * 数组——它们变了不该换一个监听器。
 *
 * live 判断这一滚算不算数（框是不是正被编辑），apply 拿到方向去做步进。
 */
export function useWheelStep(
  ref: RefObject<HTMLElement | null>,
  live: (target: HTMLElement) => boolean,
  apply: (target: HTMLInputElement, delta: 1 | -1) => void,
  enabled = true,
) {
  const latest = useRef({ live, apply });
  latest.current = { live, apply };

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !latest.current.live(target)) return;
      event.preventDefault();
      latest.current.apply(
        target as HTMLInputElement,
        event.deltaY < 0 ? 1 : -1,
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [ref, enabled]);
}
