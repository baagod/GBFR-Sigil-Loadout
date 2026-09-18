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
///                            槽序即数组下标（0 = T1、1 = T2、2 = 战气）；
///                            name/zh 不在这里——角色名走工具的 chara.lang.json。
///   loadout.json           : { lang, slots: [ { items: [
///                            {gem, level}, {hash, level}? ],
///                            enabled } ], exclusive: { player: { traitHash: bool } } }
///                            items[0] = sigil (item hash), items[1] = secondary
///                            trait (optional); a bare array is legacy-only.
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

    private sealed class ExclusiveRow
    {
        public required uint Hash { get; init; }
        public required string Player { get; init; } // PL code (e.g. PL1400)
        public required uint T1 { get; init; }
        public required uint T2 { get; init; }
        public required uint War { get; init; }
    }

    private static readonly Dictionary<uint, uint> Sigils = new();
    private static readonly Dictionary<uint, int> Traits = new();
    private static readonly Dictionary<string, List<ExclusiveRow>> ExclusiveByPlayer = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<uint, ExclusiveRow> ExclusiveByHash = new();
    private static NativeCore.ExclusiveOverrideNative[]? _appliedOverrides;
    private static DateTime _lastAppliedUtc = DateTime.MinValue;
    private static DateTime _lastAttemptUtc = DateTime.MinValue;
    private static int _failsSinceChange;
    // _failsSinceChange 属于哪一个 mtime。每拍都清零的话，catch 里的 ++ 永远是 1，
    // 重试上限和那句诊断日志就永远到不了（坏文件会被以 4 Hz 反复解析且一声不响）。
    private static DateTime _failsForUtc = DateTime.MinValue;
    private static bool _hadConfigFile;
    private static string _loadoutPath = "";
    private static string _sigilsPath = "";

    internal static void Initialize(string modDirectory, Action<string> log)
    {
        // Player config lives in the user directory so mod updates (which
        // replace the mod folder) never wipe it. No config -> built-in template.
        _loadoutPath = UserConfig.FilePath("loadout.json");
        // Keep in sync with Native/src/runtime.cpp (sigils_path in Initialize()).
        _sigilsPath = Path.Combine(modDirectory, "gem.json");
        LoadExclusiveTable(modDirectory, log);
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
                    int maxLevel = entry.TryGetProperty("cap", out JsonElement ml) &&
                                   ml.TryGetInt32(out int m)
                        ? m
                        : DefaultLevel;
                    // First row wins for a repeated skill hash (mirrors the
                    // tool's first-row trait dictionary).
                    if (Traits.TryAdd(traitHash, maxLevel))
                        traitCount++;
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
        if (!File.Exists(_loadoutPath))
        {
            if (_hadConfigFile)
            {
                _hadConfigFile = false;
                _lastAppliedUtc = DateTime.MinValue;
                _lastAttemptUtc = DateTime.MinValue;
                if (_appliedOverrides is not null)
                {
                    NativeCore.ApplyExclusiveOverrides(null); // everything enabled again
                    _appliedOverrides = null;
                }
                if (NativeCore.ApplyCustomLoadout(null))
                    log("loadout.json removed; restored the built-in exclusive template.");
            }
            return;
        }
        _hadConfigFile = true;

        DateTime mtime = File.GetLastWriteTimeUtc(_loadoutPath);
        if (mtime == _lastAppliedUtc || mtime == _lastAttemptUtc)
            return;
        if (mtime != _failsForUtc)
        {
            _failsForUtc = mtime;
            _failsSinceChange = 0;
        }

        try
        {
            // Check the size before reading so an oversized file is never
            // loaded into memory at all.
            if (new FileInfo(_loadoutPath).Length > 1024 * 1024)
                throw new InvalidDataException("loadout.json exceeds 1 MB");
            string json = File.ReadAllText(_loadoutPath);
            using JsonDocument doc = JsonDocument.Parse(json);
            var overrides = ParseExclusiveOverrides(doc.RootElement);
            var slots = ParseAndValidate(doc.RootElement);
            bool ok;
            if (slots.Count == 0)
            {
                // An existing (even empty) config means "no built-in general
                // slots": only the per-character exclusives stay active.
                log("loadout.json has no general slots; built-in exclusive template active.");
                ok = NativeCore.ApplyCustomLoadout(null);
            }
            else
            {
                ok = NativeCore.ApplyCustomLoadout(slots.ToArray());
                if (ok)
                    log($"Applied custom loadout with {slots.Count} slot(s).");
            }
            if (!ok)
            {
                log("Native rejected the custom loadout; kept previous configuration.");
                _lastAttemptUtc = mtime;
                return;
            }
            // Apply the exclusive overrides after the loadout: the native path
            // only fails while the runtime is shutting down, so rejecting a
            // loadout above leaves the previous exclusive state untouched
            // instead of a mixed new/old state. ApplyCustomLoadout already
            // re-applies the stored exclusive state, so an unchanged set needs
            // no second full rebuild (and no duplicate log line).
            if (OverridesChanged(overrides))
            {
                if (!NativeCore.ApplyExclusiveOverrides(overrides))
                    throw new InvalidDataException("native rejected the exclusive overrides");
                _appliedOverrides = overrides;
            }
            _lastAppliedUtc = mtime;
            _lastAttemptUtc = DateTime.MinValue;
        }
        catch (Exception exception)
        {
            // Transient failures (half-written file, AV lock, native not ready
            // yet) get a few 250ms-tick retries before the mtime is treated as
            // permanently rejected; a later save resets the counter above.
            if (++_failsSinceChange < 3)
                return;
            log($"Invalid loadout.json; kept previous configuration: {exception.Message}");
            _lastAttemptUtc = mtime;
        }
    }

    /// <summary>
    /// Loads gem.chara.json (the tool's per-character exclusive table) so
    /// "exclusive" keys can be PL codes as well as raw character hashes.
    /// Table missing or invalid only disables that convenience: raw hashes and
    /// the legacy t1/t2/war shape still work.
    ///
    /// 每条是 { hash, player, gems: [[因子 hash, 技能 hash] x3] }：槽序就是数组下标
    /// （0 = T1、1 = T2、2 = 战气），名字不在这里——角色名走工具的 chara.lang.json。
    /// </summary>
    private static void LoadExclusiveTable(string modDirectory, Action<string> log)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(
                File.ReadAllText(Path.Combine(modDirectory, "gem.chara.json")));
            int count = 0;
            foreach (JsonElement entry in doc.RootElement.EnumerateArray())
            {
                try
                {
                    uint[] traitHashes = new uint[3];
                    int index = 0;
                    foreach (JsonElement pair in entry.GetProperty("gems").EnumerateArray())
                    {
                        if (index >= traitHashes.Length)
                            break;
                        traitHashes[index++] = pair.GetArrayLength() == 2 ? PU(Hx(pair[1])) : 0;
                    }

                    var row = new ExclusiveRow
                    {
                        Hash = PU(Hx(entry.GetProperty("hash"))),
                        Player = Hx(entry.GetProperty("player")),
                        T1 = traitHashes[0],
                        T2 = traitHashes[1],
                        War = traitHashes[2],
                    };
                    // 三槽缺一、形状不对或解析出 0 的条目都不是可用的专属记录：宁可整条不要，
                    // 也不要一条"只有 T1"的记录去改写玩家配置。零值槽尤其危险——
                    // AddExclusiveOverride 用 PU(field.Name) 比对槽位，而它对手写文件里任何
                    // 拼错的键都返回 0，于是那条键会静默变成 T1 的开关。
                    if (row.Hash == 0 || row.Player.Length == 0 || index < traitHashes.Length ||
                        traitHashes[0] == 0 || traitHashes[1] == 0 || traitHashes[2] == 0)
                        continue;
                    if (ExclusiveByPlayer.TryGetValue(row.Player, out var playerRows))
                        playerRows.Add(row);
                    else
                        ExclusiveByPlayer[row.Player] = new List<ExclusiveRow> { row };
                    ExclusiveByHash[row.Hash] = row;
                    count++;
                }
                catch
                {
                    // one bad entry must not disable the whole table
                }
            }
            log($"Loaded {count} character exclusive entries.");
        }
        catch (Exception exception)
        {
            log($"Failed to load character-exclusive table: {exception.Message}");
        }
    }

    /// Returns every row matching the key; player codes may be shared
    /// (Gran/Djeeta are both "PL0000"). Empty = key not in the table.
    private static IReadOnlyList<ExclusiveRow> ResolveCharacters(string key)
    {
        if (ExclusiveByPlayer.TryGetValue(key, out var playerRows))
            return playerRows;
        if (ExclusiveByHash.TryGetValue(PU(key), out ExclusiveRow? row))
            return [row];
        return [];
    }

    private static void AddExclusiveOverride(
        JsonElement fields, ExclusiveRow? row, uint hash,
        List<NativeCore.ExclusiveOverrideNative> result)
    {
        bool t1 = true;
        bool t2 = true;
        bool war = true;
        foreach (JsonProperty field in fields.EnumerateObject())
        {
            if (field.Value.ValueKind != JsonValueKind.True &&
                field.Value.ValueKind != JsonValueKind.False)
                continue;
            bool value = field.Value.GetBoolean();
            uint traitHash = PU(field.Name);
            if (row != null && traitHash == row.T1)
                t1 = value;
            else if (row != null && traitHash == row.T2)
                t2 = value;
            else if (row != null && traitHash == row.War)
                war = value;
            else
                switch (field.Name)
                {
                    case "t1": t1 = value; break;
                    case "t2": t2 = value; break;
                    case "war": war = value; break;
                }
        }
        result.Add(new NativeCore.ExclusiveOverrideNative
        {
            CharacterHash = hash,
            DisableT1 = t1 ? (byte)0 : (byte)1,
            DisableT2 = t2 ? (byte)0 : (byte)1,
            DisableWar = war ? (byte)0 : (byte)1,
            Reserved = 0,
        });
    }

    /// True when every field name is a legacy bit name (t1/t2/war); only then
    /// can an unknown-key entry be applied to a raw character hash.
    private static bool HasOnlyLegacyBitNames(JsonElement fields)
    {
        foreach (JsonProperty field in fields.EnumerateObject())
        {
            string name = field.Name;
            if (name != "t1" && name != "t2" && name != "war")
                return false;
        }
        return true;
    }

    /// <summary>
    /// Parses the optional "exclusive" object
    /// ({ PL码/角色hash: { 词条hash(T1/T2/War): bool } }) into native overrides
    /// (disable bits). Missing entries stay enabled; the legacy shape
    /// ({ characterHashHex: { t1, t2, war } }) is still accepted for unknown
    /// character hashes; absent "exclusive" yields null (all enabled).
    /// </summary>
    private static NativeCore.ExclusiveOverrideNative[]? ParseExclusiveOverrides(JsonElement root)
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
            // A player key may match several rows (Gran/Djeeta share "PL0000"):
            // emit one override per character. Unknown keys only fall back to a
            // raw character hash for the legacy bit-name shape; new-shape
            // entries (trait-hash keys) without a table row cannot be resolved
            // to T1/T2/War bit names and are skipped (no-op, nothing enabled).
            IReadOnlyList<ExclusiveRow> rows = ResolveCharacters(property.Name);
            if (rows.Count == 0)
            {
                uint bareHash = PU(property.Name);
                if (bareHash == 0 || !HasOnlyLegacyBitNames(property.Value))
                    continue;
                AddExclusiveOverride(property.Value, null, bareHash, result);
                continue;
            }
            foreach (ExclusiveRow row in rows)
                AddExclusiveOverride(property.Value, row, row.Hash, result);
        }
        return result.Count == 0 ? null : result.ToArray();
    }

    /// <summary>
    /// True when the parsed overrides differ from the last successfully applied
    /// set (null = everything enabled).
    /// </summary>
    private static bool OverridesChanged(NativeCore.ExclusiveOverrideNative[]? overrides)
    {
        if (overrides is null || _appliedOverrides is null)
            return !ReferenceEquals(overrides, _appliedOverrides);
        if (overrides.Length != _appliedOverrides.Length)
            return true;
        for (int index = 0; index < overrides.Length; index++)
        {
            if (overrides[index].CharacterHash != _appliedOverrides[index].CharacterHash ||
                overrides[index].DisableT1 != _appliedOverrides[index].DisableT1 ||
                overrides[index].DisableT2 != _appliedOverrides[index].DisableT2 ||
                overrides[index].DisableWar != _appliedOverrides[index].DisableWar)
                return true;
        }
        return false;
    }

    private static List<NativeCore.TemplateSlotNative> ParseAndValidate(JsonElement root)
    {
        var result = new List<NativeCore.TemplateSlotNative>();
        if (root.ValueKind == JsonValueKind.Object)
        {
            // new config shape: { lang, slots: [...] } — lang is tool-side only
            if (!root.TryGetProperty("slots", out JsonElement slotsEl) ||
                slotsEl.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException("missing 'slots' array");
            root = slotsEl;
        }
        else if (root.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("expected an array of slots");
        }

        int index = 0;
        foreach (JsonElement slot in root.EnumerateArray())
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
