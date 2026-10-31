using System;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using System.Runtime.CompilerServices;
class LauncherHost {
    [STAThread]
    static void Main() {
        AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs args) {
            string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", new AssemblyName(args.Name).Name + ".dll");
            return File.Exists(path) ? Assembly.LoadFrom(path) : null;
        };
        try { Run(); } catch (Exception error) { MessageBox.Show(error.Message, "DeGPU 启动提示"); }
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    static void Run() {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        using (var ps = System.Management.Automation.PowerShell.Create()) {
            ps.AddScript("Set-ExecutionPolicy -Scope Process Bypass -Force").Invoke();
            ps.Commands.Clear();
            ps.AddCommand(Path.Combine(root, "scripts", "Launcher.ps1")).AddParameter("AppRoot", root);
            ps.Invoke();
            if (ps.HadErrors) {
                using (var log = new StreamWriter(Path.Combine(root, "launcher-diagnostic.log"), true))
                    foreach (var error in ps.Streams.Error) log.WriteLine(error.ToString());
            }
        }
    }
}
