using System.Diagnostics;

namespace GBFR.SigilLoadout.Configuration;

internal static class Utilities
{
    public static T TryGetValue<T>(Func<T> getValue, int timeout, int sleepTime,
        CancellationToken token = default) where T : new()
    {
        Stopwatch watch = Stopwatch.StartNew();
        bool valueSet = false;
        T value = new();

        while (watch.ElapsedMilliseconds < timeout)
        {
            if (token.IsCancellationRequested)
                return value;
            try
            {
                value = getValue();
                valueSet = true;
                break;
            }
            catch
            {
            }
            Thread.Sleep(sleepTime);
        }

        if (!valueSet)
            throw new Exception($"Timeout limit {timeout} exceeded.");
        return value;
    }
}
