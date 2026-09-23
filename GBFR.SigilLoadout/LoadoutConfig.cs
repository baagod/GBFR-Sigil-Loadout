using System.Globalization;
using System.Text.Json;

namespace GBFR.SigilLoadout;

/// <summary>
/// 读可选的 loadout.json（玩家/编辑器工具写），经 ABI 推进原生运行时模板表。内置专属模板不靠任何
/// 配置文件保留；文件无效就记一条日志，上一份有效配置继续生效。
///
/// **本类只做一件事：把可视工具写下的载荷映射成 ABI 结构；不读数据文件、不持有任何表。**
/// "物品 → 主技能 / 上限"的语义只属于唯一写者（可视工具，它读 assets\sigils.json），所以载荷
/// 自带 items[0].hash（主技能）。选得对不对、有没有超上限，在这一层都不再判。
///
/// 数据模型（mod 只读它映射的那些字段）：
///   { lang, slots: [ { items: [ {gem, hash, level}, {hash, level}? ], enabled } ],
///     exclusive: { 角色hash: { 技能hash: bool } } }
///   items[0] = sigil（gem = 物品 hash，hash = 它给的主技能）；items[1] = 副技能（可选）。
///   exclusive 只写 false 的那些：没提到的角色就是三槽全开。
/// 只做形状校验：JSON 坏掉、缺技能 hash、等级不对、槽位太多。
/// </summary>
internal static class LoadoutConfig {
    // 配装配置的路径：可视工具写、这里读。文件名字面量只出现在这一处（有一道对拍断言盯着它）。
    private static readonly string ConfigFile = UserConfig.FilePath("loadout.json");

    // 与 Native/native_internal.h 的 kUnwornCharacterHash 保持同步（0x887AE0B0）
    private const uint UnwornCharacterHash = 0x887AE0B0;
    // 与 SigilLoadout/loadoutservice.go 的 MaxSlots 保持同步
    private const int MaxSlots = 12; // 保守上限（槽位更多有失稳风险）
    private const int DefaultLevel = 15;

    // 版本门。本类用它的"认领"那一半（Changed）：见 Tick 里为什么有意无条件认领。
    private static readonly FileStamp Stamp = new(ConfigFile);

    internal static void Initialize(Action<string> log) {
        if (Stamp.Changed() is DateTime mtime)
            TryApply(log, mtime);
    }

    internal static void Tick(Action<string> log) {
        // 认领后处理：这一版无论成败都算处理过了。有意如此——单次应用失败就保留上一份配置，
        // 下一次保存自然会改 mtime；重试同一份坏配置只会把同一个报错每 250ms 灌一遍。
        if (Stamp.Changed() is not DateTime mtime)
            return;
        TryApply(log, mtime);
    }

    /// <summary>
    /// 按 <paramref name="mtime"/> 这一版应用配置。本类有意无条件认领（见 <see cref="Tick"/>），所以
    /// 成功与失败之后一样：都等下一版。
    /// </summary>
    private static void TryApply(Action<string> log, DateTime mtime) {
        if (mtime == UserConfig.NoFile) {
            // 两半都给 null：没有通用槽 = 内置模板，没有开关 = 专属全开。
            if (NativeCore.ApplyLoadout(null, null))
                log("loadout.json removed; restored the built-in exclusive template.");
            // 这条路径到此为止。少了它就会落到下面那次读取上：文件不存在时 new FileInfo(...).Length
            // 必抛 FileNotFoundException，被 catch 接住后每局多一条假的 "Invalid loadout.json; kept
            // previous configuration"——而这条路上根本不存在"上一份"可保。
            return;
        }

        try {
            // 读之前先查大小，超大文件根本不会被读进来。
            if (new FileInfo(ConfigFile).Length > Config.MaxBytes)
                throw new InvalidDataException("loadout.json exceeds 1 MB");
            string json = File.ReadAllText(ConfigFile);
            using JsonDocument doc = JsonDocument.Parse(json);
            var overrides = ParseExclusiveOverrides(doc.RootElement, log);
            var slots = ParseAndValidate(doc.RootElement);
            // 一次调用交两半：通用槽 + 专属开关。两半都落在原生同一个"重新发布"步骤上，
            // 所以分成两次（v17 的形状）只会让同一张表被发布、被打印两遍。
            bool ok;
            if (slots.Count == 0) {
                // 存在（哪怕是空的）配置就等于"没有内置通用槽"：只留专属开关。
                log("loadout.json has no general slots; built-in exclusive template active.");
                ok = NativeCore.ApplyLoadout(null, overrides);
            }
            else {
                ok = NativeCore.ApplyLoadout(slots.ToArray(), overrides);
                if (ok)
                    log($"Applied custom loadout, slots={slots.Count}.");
            }
            if (!ok)
                log("Native rejected the custom loadout; kept previous configuration.");
        }
        catch (Exception exception) {
            // 读取失败的原因照常报（日志由 Tick 的"版本变了才说"去重）；下一次保存会改 mtime，
            // 那时自然会被重新处理。
            log($"Invalid loadout.json; kept previous configuration: {exception.Message}");
        }
    }

    /// <summary>
    /// 把可选的 "exclusive" 对象解析成原生覆盖项。
    ///
    /// 形状：{ 角色hash: { 技能hash: bool } }。只把 **false**（= 关掉）变成一条 override，因为
    /// "没说"和"说开着"是同一件事：原生侧对没被提到的角色一律三槽全开。槽位由技能 hash 决定，而
    /// 那张专属表在原生侧，所以这里只做转发——不需要 sigils.chara.json，也不需要知道哪个是 T1。
    ///
    /// 只认这一种形状：外层键必须是角色 hash（十六进制），解析不出就记一行日志并忽略；内层键认不
    /// 出的由原生侧忽略。
    /// </summary>
    private static NativeCore.ExclusiveOverrideNative[]? ParseExclusiveOverrides(
        JsonElement root, Action<string> log) {
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("exclusive", out JsonElement exclusive) ||
            exclusive.ValueKind != JsonValueKind.Object)
            return null;

        var result = new List<NativeCore.ExclusiveOverrideNative>();
        foreach (JsonProperty property in exclusive.EnumerateObject()) {
            if (property.Value.ValueKind != JsonValueKind.Object)
                continue;
            uint characterHash = PU(property.Name);
            if (characterHash == 0) {
                // PL 码是可视工具显示用的标签，不是这里的身份（也不兼容）：说出来，
                // 否则"开关点了没用"在日志里没有任何线索。
                log($"exclusive: '{property.Name}' is not a character hash; ignored.");
                continue;
            }
            foreach (JsonProperty field in property.Value.EnumerateObject()) {
                if (field.Value.ValueKind != JsonValueKind.False)
                    continue;
                uint skillHash = PU(field.Name);
                if (skillHash == 0) {
                    log($"exclusive: '{property.Name}' has a non-hash skill key '{field.Name}'; ignored.");
                    continue;
                }
                result.Add(new NativeCore.ExclusiveOverrideNative {
                    CharacterHash = characterHash,
                    SkillHash = skillHash,
                    Disabled = 1,
                });
            }
        }
        return result.Count == 0 ? null : result.ToArray();
    }

    private static List<NativeCore.TemplateSlotNative> ParseAndValidate(JsonElement root) {
        // 只认这一种形状：{ lang, slots: [...] }（lang 只有可视工具在意）。可视工具侧写的就是它，
        // Go 的 SaveLoadout 也会把别的拼写当场拒掉——所以这里没有第二种读法。
        if (root.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("expected an object with a 'slots' array");
        if (!root.TryGetProperty("slots", out JsonElement slots) ||
            slots.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("missing 'slots' array");

        var result = new List<NativeCore.TemplateSlotNative>();
        int index = 0;
        foreach (JsonElement slot in slots.EnumerateArray()) {
            index++;
            bool enabled = !slot.TryGetProperty("enabled", out JsonElement enabledElement) ||
                           enabledElement.GetBoolean();
            if (!enabled)
                continue;
            if (result.Count >= MaxSlots)
                throw new InvalidDataException($"more than {MaxSlots} enabled slots");

            if (!slot.TryGetProperty("items", out JsonElement items) ||
                items.ValueKind != JsonValueKind.Array || items.GetArrayLength() < 1)
                throw new InvalidDataException($"slot {index}: missing 'items' array");

            JsonElement main = items[0];
            string mainGem = Hx(main.GetProperty("gem"));
            uint mainGemHash = PU(mainGem);
            if (mainGemHash == 0)
                throw new InvalidDataException($"slot {index}: bad sigil hash '{mainGem}'");
            // 主技能由可视工具写进来（唯一读 sigils.json 的一方），这一层不查表、也不猜。
            if (!main.TryGetProperty("hash", out JsonElement mainHash))
                throw new InvalidDataException($"slot {index}: main item carries no skill hash");
            uint mainSkill = PU(Hx(mainHash));
            if (mainSkill == 0)
                throw new InvalidDataException($"slot {index}: bad main skill hash");
            int level1 = GetLevel(main, "level", index);

            uint skill2Hash = UnwornCharacterHash; // "未选择"哨兵，永不为 0
            int skill2Level = 0;
            if (items.GetArrayLength() >= 2) {
                JsonElement sec = items[1];
                string secHash = Hx(sec.GetProperty("hash"));
                skill2Hash = PU(secHash);
                if (skill2Hash == 0)
                    throw new InvalidDataException($"slot {index}: bad secondary skill hash '{secHash}'");
                skill2Level = GetLevel(sec, "level", index);
            }
            result.Add(new NativeCore.TemplateSlotNative {
                GemId = mainGemHash,
                Skill1 = mainSkill,
                Skill1Level = level1,
                Skill2 = skill2Hash,
                Skill2Level = skill2Level,
                SigilLevel = level1,
            });
        }
        return result;
    }

    // 等级只要求非负：上界是每条技能自己的 cap，而唯一持有那张表的是可视工具（它写之前已经夹在
    // cap 内）。在这一层再判一次上界就是同一规则的第三份副本，判的还不是真正的不变量。
    private static int GetLevel(JsonElement item, string propertyName, int index) {
        if (!item.TryGetProperty(propertyName, out JsonElement element))
            return DefaultLevel;
        int level = element.GetInt32();
        if (level < 0)
            throw new InvalidDataException($"slot {index}: {propertyName} must not be negative");
        return level;
    }

    private static string Hx(JsonElement e) =>
        e.ValueKind == JsonValueKind.String ? (e.GetString() ?? "").Trim().ToUpperInvariant() : "";

    private static uint PU(string hex) =>
        uint.TryParse(hex, NumberStyles.HexNumber, null, out uint value) ? value : 0;
}
