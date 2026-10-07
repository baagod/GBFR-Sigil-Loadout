/*
"motion 会被拼进文件名"这条不变式，一个入口挡住不等于挡住 —— 六个入口都得挡住。

坏值覆盖四类：空串、位数不对（3 位 / 5 位）、大写（文件名是十六进制小写）、路径穿越（../x、反斜杠）。
只传坏值，所以不会真写东西；装置（actionsFixture）本来也把四个设置都指向临时目录。
*/
package service

import "testing"

func TestEveryMotionEntryPointRejectsBadMotions(t *testing.T) {
	service, _, _ := actionsFixture(t)
	calls := map[string]func(motion string) error{
		"LoadFlags":           func(m string) error { _, err := service.LoadFlags(m); return err },
		"LoadFlagsOriginal":   func(m string) error { _, err := service.LoadFlagsOriginal(m); return err },
		"SaveFlags":           func(m string) error { return service.SaveFlags(m, nil) },
		"ListTracks":          func(m string) error { _, err := service.ListTracks(m); return err },
		"SaveTracks":          func(m string) error { return service.SaveTracks(m, nil) },
		"DeployMissingTracks": func(m string) error { return service.DeployMissingTracks(m) },
	}
	for name, call := range calls {
		for _, motion := range []string{"", "340", "34000", "340A", "../x", `pl\1000`} {
			if err := call(motion); err == nil {
				t.Errorf("%s(%q) 没挡住", name, motion)
			}
		}
	}
}
