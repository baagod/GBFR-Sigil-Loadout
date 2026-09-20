using System.Globalization;
using System.Text.Json;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// Reads the optional loadout.json (written by the player/editor tool) and
/// pushes it into the native runtime template table through the ABI.
/// No config file keeps the built-in exclusive template; invalid files are
/// reported and the last valid configuration stays active.
///
/// **本类只做一件事：把可视工具写下的载荷映射成 ABI 结构。它不读任何数据文件、不持有任何表。**
/// "物品 → 主技能 / 上限"的语义只属于唯一写者（可视工具，它读 assets\gem.json），所以载荷自带
/// items[0].hash（主技能）。选得对不对、有没有超上限，在这一层都不再判：可视工具是唯一写者，
/// 手写歪了的载荷它不认。
///
/// Data model (mod reads only the fields it maps):
///   loadout.json : { lang, slots: [ { items: [ {gem, hash, level},
///                    {hash, level}? ], enabled } ],
///                    exclusive: { 角色hash: { 技能hash: bool } } }
///                  items[0] = sigil（gem = 物品 hash，hash = 它给的主技能）；
///                  items[1] = 副技能（可选，没有就不写这一项）。
///                  exclusive 只写 false 的那些：没提到的角色就是三槽全开。
/// Shape validation only: malformed JSON, a missing skill hash, a bad level,
/// or too many enabled slots.
/// </summary>
internal static class LoadoutConfig
{
    // keep in sync with Native/native_internal.h kUnwornCharacterHash (0x887AE0B0)
    private const uint UnwornCharacterHash = 0x887AE0B0;
    // keep in sync with Loadout/loadoutservice.go MaxSlots
    private const int MaxSlots = 12; // conservative cap (more slots risk instability)
    private const int DefaultLevel = 15;

    // 配置文件唯一的状态：**已经处理过**的那份内容的 mtime。应用成功是它，读不出来或被
    // 原生拒掉也是它——写下这一条就是认领，所以同一份内容不会被解析第二次，坏文件也不会
    // 每 250ms 刷一次日志。
    //
    // 初值就是"没有这个文件"那个时间戳，所以"配置被删了"是一次正常的 mtime 变化，不需要
    // 额外字段去记住"以前有过文件"。这份约定只有一处实现：UserConfig.Stamp（SigilEditFeature
    // 那条同样用它）。
    private static DateTime _handledUtc = UserConfig.NoFile;
    private static string _loadoutPath = "";

    internal static void Initialize(Action<string> log)
    {
        // Player config lives in the user directory so mod updates (which
        // replace the mod folder) never wipe it. No config -> built-in template.
        _loadoutPath = UserConfig.FilePath("loadout.json");
        TryApply(log);
    }

    internal static void Tick(Action<string> log)
    {
        // TryApply owns the mtime/deletion gating: a deleted file must reach it
        // too (it restores the built-in template), and an unchanged file exits
        // after one File.GetLastWriteTimeUtc call.
        TryApply(log);
    }

    private static void TryApply(Action<string> log)
    {
        // 文件不存在时 Stamp 给的是 UserConfig.NoFile，那是一个与任何真实 mtime 都不相等的、
        // 可认领的状态，所以"删掉配置"和"改过配置"走同一条门。
        DateTime mtime = UserConfig.Stamp(_loadoutPath);
        if (mtime == _handledUtc)
            return;

        if (mtime == UserConfig.NoFile)
        {
            _handledUtc = mtime;
            // 两半都给 null：没有通用槽 = 内置模板，没有开关 = 专属全开。这就是原来的
            // "先清 overrides、再恢复内置模板"两步合成的同一件事。
            if (NativeCore.ApplyLoadout(null, null))
                log("loadout.json removed; restored the built-in exclusive template.");
            return;
        }

        try
        {
            // Check the size before reading so an oversized file is never
            // loaded into memory at all.
            if (new FileInfo(_loadoutPath).Length > 1024 * 1024)
                throw new InvalidDataException("loadout.json exceeds 1 MB");
            string json = File.ReadAllText(_loadoutPath);
            using JsonDocument doc = JsonDocument.Parse(json);
            var overrides = ParseExclusiveOverrides(doc.RootElement, log);
            var slots = ParseAndValidate(doc.RootElement);
            // 一次调用交两半：通用槽 + 专属开关。两半都落在原生同一个"重新发布"步骤上，
            // 所以分成两次（v17 的形状）只会让同一张表被发布、被打印两遍。
            bool ok;
            if (slots.Count == 0)
            {
                // An existing (even empty) config means "no built-in general
                // slots": only the per-character exclusives stay active.
                log("loadout.json has no general slots; built-in exclusive template active.");
                ok = NativeCore.ApplyLoadout(null, overrides);
            }
            else
            {
                ok = NativeCore.ApplyLoadout(slots.ToArray(), overrides);
                if (ok)
                    log($"Applied custom loadout with {slots.Count} slot(s).");
            }
            if (!ok)
            {
                log("Native rejected the custom loadout; kept previous configuration.");
                _handledUtc = mtime;
                return;
            }
            _handledUtc = mtime;
        }
        catch (Exception exception)
        {
            // 这份内容只报一次，然后就不再碰它：写入方是原子写（temp + rename），所以
            // "读到半截文件"不存在；而一个被杀软锁住或被人改坏的文件，再解析三次也同样
            // 读不出来——那 750ms 只推迟了诊断，没有换来别的。下一次保存会改 mtime，
            // 那时它自然会被重新处理。
            _handledUtc = mtime;
            log($"Invalid loadout.json; kept previous configuration: {exception.Message}");
        }
    }

    /// <summary>
    /// Parses the optional "exclusive" object into native overrides.
    ///
    /// 形状：{ 角色hash: { 技能hash: bool } }。只把 **false**（= 关掉）变成一条
    /// override，因为"没说"和"说开着"是同一件事：原生侧对没被提到的角色一律三槽全开。
    /// 槽位由技能 hash 决定，而那张专属表在原生侧，所以这里只做转发——不需要 gem.chara.json，
    /// 也不需要知道哪个 hash 是 T1。
    ///
    /// 只认这一种形状：外层键必须是角色 hash（十六进制），解析不出就记一行日志并忽略；
    /// 内层键必须是这个技能 hash，认不出的由原生侧忽略。没有兼容形状。
    /// </summary>
    private static NativeCore.ExclusiveOverrideNative[]? ParseExclusiveOverrides(
        JsonElement root, Action<string> log)
    {
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("exclusive", out JsonElement exclusive) ||
            exclusive.ValueKind != JsonValueKind.Object)
            return null;

        var result = new List<NativeCore.ExclusiveOverrideNative>();
        foreach (JsonProperty property in exclusive.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.Object)
                continue;
            uint characterHash = PU(property.Name);
            if (characterHash == 0)
            {
                // PL 码是可视工具显示用的标签，不是这里的身份（也不兼容）：说出来，
                // 否则"开关点了没用"在日志里没有任何线索。
                log($"exclusive: '{property.Name}' is not a character hash; ignored.");
                continue;
            }
            foreach (JsonProperty field in property.Value.EnumerateObject())
            {
                if (field.Value.ValueKind != JsonValueKind.False)
                    continue;
                uint skillHash = PU(field.Name);
                if (skillHash == 0)
                {
                    log($"exclusive: '{property.Name}' has a non-hash skill key '{field.Name}'; ignored.");
                    continue;
                }
                result.Add(new NativeCore.ExclusiveOverrideNative
                {
                    CharacterHash = characterHash,
                    SkillHash = skillHash,
                    Disabled = 1,
                });
            }
        }
        return result.Count == 0 ? null : result.ToArray();
    }

    private static List<NativeCore.TemplateSlotNative> ParseAndValidate(JsonElement root)
    {
        // 只认这一种形状：{ lang, slots: [...] }（lang 只有可视工具在意）。可视工具侧写的就是它，
        // Go 的 SaveLoadout 也会把别的拼写当场拒掉——所以这里没有第二种读法。
        if (root.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("expected an object with a 'slots' array");
        if (!root.TryGetProperty("slots", out JsonElement slots) ||
            slots.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("missing 'slots' array");

        var result = new List<NativeCore.TemplateSlotNative>();
        int index = 0;
        foreach (JsonElement slot in slots.EnumerateArray())
        {
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
            // 主技能由可视工具写进来（唯一读 gem.json 的一方），这一层不查表、也不猜。
            if (!main.TryGetProperty("hash", out JsonElement mainHash))
                throw new InvalidDataException($"slot {index}: main item carries no skill hash");
            uint mainSkill = PU(Hx(mainHash));
            if (mainSkill == 0)
                throw new InvalidDataException($"slot {index}: bad main skill hash");
            int level1 = GetLevel(main, "level", index);

            uint skill2Hash = UnwornCharacterHash; // "not selected" sentinel, never 0
            int skill2Level = 0;
            if (items.GetArrayLength() >= 2)
            {
                JsonElement sec = items[1];
                string secHash = Hx(sec.GetProperty("hash"));
                skill2Hash = PU(secHash);
                if (skill2Hash == 0)
                    throw new InvalidDataException($"slot {index}: bad secondary skill hash '{secHash}'");
                skill2Level = GetLevel(sec, "level", index);
            }
            result.Add(new NativeCore.TemplateSlotNative
            {
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
    private static int GetLevel(JsonElement item, string propertyName, int index)
    {
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
