import {describe, expect, it} from "vitest"
import {paramFieldLabel, paramTableLabel} from "@/lib/paramlabels"
import type {ParamLabels} from "../../bindings/sigilloadout/service/models"

const labels: ParamLabels = {
    tables: {"guardparam.msg": "格挡参数"},
    segments: {
        GuardParam: "格挡参数",
        GuardGageMax: "格挡值上限",
        searchTargetInfoList_: "索敌信息列表",
        maxLen: "搜索距离上限",
        rate_: "倍率",
        isEnableStickInput: "允许摇杆输入",
        nearDistanceAutoHomingParam_: "近距离自动追踪参数",
    },
    overrides: {"playerailmentparameter.msg|rate_": "倍率（异常状态覆盖）"},
}

describe("全员参数译名", () => {
    it("表名：有译名用译名，没有就用去掉 .msg 的文件名", () => {
        expect(paramTableLabel(labels, "guardparam.msg")).toBe("格挡参数")
        expect(paramTableLabel(labels, "unknown.msg")).toBe("unknown")
    })

    it("字段：丢掉根对象名，逐段查译名后用 › 连接", () => {
        expect(paramFieldLabel(labels, "guardparam.msg", "GuardParam.GuardGageMax")).toBe("格挡值上限")
    })

    it("数组下标不显示、Element 包装层跳过", () => {
        expect(
            paramFieldLabel(labels, "playerautohomingparameter.msg", "PlayerAutoHomingParameter.searchTargetInfoList_[0].Element.maxLen"),
        ).toBe("索敌信息列表 0 › 搜索距离上限")
    })

    it("数组下标粘在所属段名字后面（用户口径：索敌信息列表8）", () => {
        expect(
            paramFieldLabel(labels, "playerautohomingparameter.msg", "PlayerAutoHomingParameter.searchTargetInfoList_[8].Element.isEnableStickInput"),
        ).toBe("索敌信息列表 8 › 允许摇杆输入")
    })

    it("独立的数字段不占一段，直接粘到上一段（.1. → 索敌信息列表1）", () => {
        expect(
            paramFieldLabel(
                labels,
                "playerautohomingparameter.msg",
                "PlayerAutoHomingParameter.nearDistanceAutoHomingParam_.searchTargetInfoList_.1.Element.isEnableStickInput",
            ),
        ).toBe("近距离自动追踪参数 › 索敌信息列表 1 › 允许摇杆输入")
    })

    it("覆盖优先于通用片段；查不到的片段保留原文", () => {
        expect(paramFieldLabel(labels, "playerailmentparameter.msg", "X.rate_")).toBe("倍率（异常状态覆盖）")
        expect(paramFieldLabel(labels, "playerailmentparameter.msg", "X.unknownField_")).toBe("unknownField_")
    })

    it("译名表还没到时，整行回落成原始路径（不能出现空字符串）", () => {
        expect(paramFieldLabel(null, "guardparam.msg", "GuardParam.GuardGageMax")).toBe("GuardGageMax")
    })
})
