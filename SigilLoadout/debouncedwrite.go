package main

import (
	"log"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// debouncedWriter 是"编辑停下来才落盘"的那套骨架：待写只有一份、写盘只在 mu 里发生，所以两次写不会
// 并发，退出时也能由 flushNow 把它交出去（见 main.go 的两个 OnShutdown）。两个 service 共用。
//
// 落盘由 write 负责（各 service 不同）；"失败就放回待写 + 记日志 + 推给前端"这三件事在这里统一做。
type debouncedWriter[T any] struct {
	mu      sync.Mutex
	pending *T
	timer   *time.Timer
	label   string
	write   func(T) error
}

func (w *debouncedWriter[T]) submit(label string, write func(T) error, value T) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.label, w.write = label, write
	w.pending = &value
	if w.timer == nil {
		w.timer = time.AfterFunc(debounceDelay, w.flush)
	} else {
		w.timer.Reset(debounceDelay)
	}
}

// flushNow 供关闭流程用：窗口可能在防抖窗口里就关掉，而刚做的那次编辑才是用户想留下的。已经写过的
// 不在待写里，所以它和 flush 都不会写第二遍。
func (w *debouncedWriter[T]) flushNow() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timer != nil {
		w.timer.Stop()
	}
	w.flushLocked()
}

func (w *debouncedWriter[T]) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.flushLocked()
}

// 调用方持有 w.mu。
func (w *debouncedWriter[T]) flushLocked() {
	value := w.pending
	w.pending = nil
	if value == nil {
		return
	}
	if err := w.write(*value); err != nil {
		// 放回待写：一次瞬时 IO 失败不该变成永久丢失，下一次防抖或退出时的 flushNow 就是重试。
		// 这个失败已经没有调用方可以返回，只能推给前端。
		w.pending = value
		log.Printf("%s: %v", w.label, err)
		if app := application.Get(); app != nil {
			app.Event.Emit(saveFailedEvent, err.Error())
		}
	}
}
