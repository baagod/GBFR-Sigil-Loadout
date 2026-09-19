using System.Text.Json;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// Reads the optional loadout.json (written by the player/editor tool) and
/// pushes it into the native runtime template table through the ABI.
/// No config file keeps the built-in exclusive template; invalid files are
/// reported and the last valid configuration stays active.
///
/// Data model (mod parses only the fields it needs; field names follow
/// gem.xlsx headers for gem.json):
///   gem.json               : { sigils: [ { key, hash, skill1, skill2,
///                            mix, category, player, onlyone, cap, lot, character? } ] }
///                            item rows: hash != skill1; non-item skill rows:
///                            hash == skill1 (trait entries only, no item).
///                            No display names here: they live in the tool's
///                            gem.lang.json, which the mod never reads.
///   gem.chara.json         : [ { hash, player, gems: [ [gemHash, traitHash] x3 ] } ]
///                            工具的专属页读它（角色名走 chara.lang.json）。**本类不读它**：
///                            专属开关经 ABI 以词条 hash 转发，是哪个槽由原生侧认。
///   loadout.json           : { lang, slots: [ { items: [
///                            {gem, level}, {hash, level}? ],
///                            enabled } ], exclusive: { 角色hash: { 词条hash: bool } } }
///                            exclusive 只写 false 的那些：没提到的角色就是三槽全开。
///                            items[0] = sigil (item hash), items[1] = secondary
///                            trait (optional).
/// Soft validation: any combination is accepted (no secondaries check yet);
/// hard validation only: unknown hashes / bad levels / too many slots.
/// </summary>
internal static class LoadoutConfig
{
    // keep in sync with Native/native_internal.h kUnwornCharacterHash (0x887AE0B0)
    private const uint UnwornCharacterHash = 0x887AE0B0;
    // keep in sync with Loadout/loadoutservice.go MaxSlots
    private const int MaxSlots = 12; // conservative cap (more slots risk instability)
    private const int DefaultLevel = 15;

    private static readonly Dictionary<uint, uint> Sigils = new();
    private static readonly Dictionary<uint, int> Traits = new();
    // 配置文件唯一的状态：**已经处理过**的那份内容的 mtime。应用成功是它，读不出来或被
    // 原生拒掉也是它——写下这一条就是认领，所以同一份内容不会被解析第二次，坏文件也不会
    // 每 250ms 刷一次日志。
    //
    // DateTime.MinValue 代表"没有配置"：File.GetLastWriteTimeUtc 对不存在的文件给的正是
    // 这个值（与 SigilEditFeature.LastWriteUtc 同一个约定），所以"配置被删了"也是一次
    // 正常的 mtime 变化，不需要额外字段去记住"以前有过文件"。
    private static DateTime _handledUtc = DateTime.MinValue;
    private static string _loadoutPath = "";
    private static string _sigilsPath = "";

    internal static void Initialize(string modDirectory, Action<string> log)
    {
        // Player config lives in the user directory so mod updates (which
        // replace the mod folder) never wipe it. No config -> built-in template.
        _loadoutPath = UserConfig.FilePath("loadout.json");
        // 随包数据住在 mod 目录的 assets\ 下（与源码树的 Loadout\assets\ 同一布局）。
        // Keep in sync with Native/src/runtime.cpp (sigils_path in Initialize()).
        _sigilsPath = Path.Combine(modDirectory, "assets", "gem.json");
        if (LoadTables(log))
            TryApply(log);
        else
            log("Custom loadout disabled: sigil/trait data files are missing or invalid.");
    }

    internal static void Tick(Action<string> log)
    {
        if (Traits.Count == 0)
            return;
        // TryApply owns the mtime/deletion gating: a deleted file must reach it
        // too (it restores the built-in template), and an unchanged file exits
        // after one File.GetLastWriteTimeUtc call.
        TryApply(log);
    }

    private static bool LoadTables(Action<string> log)
    {
        try
        {
            // Merged single table: item rows (hash != skill1) + non-item skill
            // rows (hash == skill1); every row also registers its trait (skill1
            // hash -> cap).
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(_sigilsPath));
            int sigilCount = 0;
            int traitCount = 0;
            foreach (JsonElement entry in doc.RootElement.GetProperty("sigils").EnumerateArray())
            {
                try
                {
                    // Key by the parsed hash (not the raw string): the ABI
                    // carries uint trait hashes, so the lookup can never
                    // depend on the file's hex formatting.
                    uint traitHash = PU(Hx(entry.GetProperty("skill1")));
                    if (traitHash == 0)
                        continue;
                    // 专属行不作词条：专属因子的词条只经由 exclusive 段生效，界面的
                    // 词条下拉也从不提供它们。这条规则与工具侧同一份实现（model.ts
                    // traitTableOf）——两边各写一条正是它们能悄悄分叉的原因。
                    bool exclusiveRow = entry.TryGetProperty("player", out JsonElement player) &&
                        player.ValueKind == JsonValueKind.String &&
                        (player.GetString() ?? "").Length > 0;
                    if (!exclusiveRow)
                    {
                        int maxLevel = entry.TryGetProperty("cap", out JsonElement ml) &&
                                       ml.TryGetInt32(out int m)
                            ? m
                            : DefaultLevel;
                        // First row wins for a repeated skill hash.
                        if (Traits.TryAdd(traitHash, maxLevel))
                            traitCount++;
                    }
                    uint itemHash = PU(Hx(entry.GetProperty("hash")));
                    if (itemHash == traitHash) // non-item skill rows: trait only
                        continue;
                    if (Sigils.TryAdd(itemHash, traitHash))
                        sigilCount++;
                }
                catch
                {
                    // one bad entry must not disable the whole table
                }
            }
            log($"Loaded {sigilCount} sigil and {traitCount} trait entries.");
            return Traits.Count > 0 && Sigils.Count > 0;
        }
        catch (Exception exception)
        {
            log($"Failed to load merged sigil/trait table: {exception.Message}");
            return false;
        }
    }

    private static void TryApply(Action<string> log)
    {
        // 文件不存在时 GetLastWriteTimeUtc 给的是 DateTime.MinValue，那是一个与任何真实
        // mtime 都不相等的、可认领的状态，所以"删掉配置"和"改过配置"走同一条门。
        DateTime mtime = File.Exists(_loadoutPath)
            ? File.GetLastWriteTimeUtc(_loadoutPath)
            : DateTime.MinValue;
        if (mtime == _handledUtc)
            return;

        if (mtime == DateTime.MinValue)
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
    /// 形状：{ 角色hash: { 词条hash: bool } }。只把 **false**（= 关掉）变成一条
    /// override，因为"没说"和"说开着"是同一件事：原生侧对没被提到的角色一律三槽全开。
    /// 槽位由词条 hash 决定，而那张专属表在原生侧，所以这里只做转发——不需要 gem.chara.json，
    /// 也不需要知道哪个 hash 是 T1。
    ///
    /// 只认这一种形状：外层键必须是角色 hash（十六进制），解析不出就记一行日志并忽略；
    /// 内层键必须是这个词条 hash，认不出的由原生侧忽略。没有兼容形状。
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
                // PL 码是工具显示用的标签，不是这里的身份（也不兼容）：说出来，
                // 否则"开关点了没用"在日志里没有任何线索。
                log($"exclusive: '{property.Name}' is not a character hash; ignored.");
                continue;
            }
            foreach (JsonProperty field in property.Value.EnumerateObject())
            {
                if (field.Value.ValueKind != JsonValueKind.False)
                    continue;
                uint traitHash = PU(field.Name);
                if (traitHash == 0)
                {
                    log($"exclusive: '{property.Name}' has a non-hash trait key '{field.Name}'; ignored.");
                    continue;
                }
                result.Add(new NativeCore.ExclusiveOverrideNative
                {
                    CharacterHash = characterHash,
                    TraitHash = traitHash,
                    Disabled = 1,
                });
            }
        }
        return result.Count == 0 ? null : result.ToArray();
    }

    private static List<NativeCore.TemplateSlotNative> ParseAndValidate(JsonElement root)
    {
        // 只认这一种形状：{ lang, slots: [...] }（lang 只有工具在意）。工具侧写的就是它，
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
            if (!Sigils.TryGetValue(mainGemHash, out uint mainSkill))
                throw new InvalidDataException($"slot {index}: unknown sigil '{mainGem}'");
            int mainCap = Traits.TryGetValue(mainSkill, out int traitCap)
                ? traitCap
                : DefaultLevel;
            int level1 = GetLevel(main, "level", index, mainCap);

            uint trait2Hash = UnwornCharacterHash; // "not selected" sentinel, never 0
            int trait2Level = 0;
            if (items.GetArrayLength() >= 2)
            {
                JsonElement sec = items[1];
                string secHash = Hx(sec.GetProperty("hash"));
                trait2Hash = PU(secHash);
                if (!Traits.TryGetValue(trait2Hash, out int secCap))
                    throw new InvalidDataException($"slot {index}: unknown trait '{secHash}'");
                trait2Level = GetLevel(sec, "level", index, secCap);
            }
            result.Add(new NativeCore.TemplateSlotNative
            {
                GemId = mainGemHash,
                Trait1 = mainSkill,
                Trait1Level = level1,
                Trait2 = trait2Hash,
                Trait2Level = trait2Level,
                SigilLevel = level1,
            });
        }
        return result;
    }

    private static int GetLevel(JsonElement item, string propertyName, int index, int maxLevel)
    {
        if (!item.TryGetProperty(propertyName, out JsonElement element))
            return DefaultLevel;
        int level = element.GetInt32();
        if (level < 0 || level > maxLevel)
            throw new InvalidDataException($"slot {index}: {propertyName} out of range 0-{maxLevel}");
        return level;
    }

    private static string Hx(JsonElement e) =>
        e.ValueKind == JsonValueKind.String ? (e.GetString() ?? "").Trim().ToUpperInvariant() : "";

    private static uint PU(string hex)
    {
        try { return Convert.ToUInt32(hex, 16); }
        catch { return 0; }
    }
}
