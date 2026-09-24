using System.Windows;
using System.Windows.Threading;
using MiniTC.Services;
using Velopack;

namespace MiniTC;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // Must run before any UI: on an update/install/uninstall hook Velopack
        // performs its work and exits the process here.
        VelopackApp.Build().Run();

        base.OnStartup(e);

        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            LogFatal(args.ExceptionObject as Exception);

        // Small, fast reads: doing them synchronously keeps the first frame
        // correct and avoids a visible theme flash on startup.
        var theme = ThemeService.LoadAsync().GetAwaiter().GetResult();
        ThemeService.Apply(theme);

        ShortcutService.LoadAsync().GetAwaiter().GetResult();
        PreviewService.LoadConfigAsync().GetAwaiter().GetResult();

        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        LogFatal(e.Exception);

        MessageBox.Show(
            $"发生未处理的错误：\n\n{e.Exception.Message}",
            "MiniTC",
            MessageBoxButton.OK,
            MessageBoxImage.Error);

        // Keep running: a failed file operation or preview must not take the
        // whole file manager down.
        e.Handled = true;
    }

    private static void LogFatal(Exception? exception)
    {
        if (exception is null)
        {
            return;
        }

        try
        {
            var path = System.IO.Path.Combine(ConfigStore.Root, "crash.log");
            System.IO.Directory.CreateDirectory(ConfigStore.Root);
            System.IO.File.AppendAllText(path,
                $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {exception}{Environment.NewLine}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never throw.
        }
    }
}
