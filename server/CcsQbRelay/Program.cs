using System.Runtime.InteropServices;
using CcsQbRelay;
using Microsoft.Extensions.Hosting.WindowsServices;

// Suppress Windows Error Reporting dialogs for any child processes spawned by this process.
// SEM_FAILCRITICALERRORS (0x0001) - Don't display the critical-error-handler message box
// SEM_NOGPFAULTERRORBOX  (0x0002) - Don't display the Windows Error Reporting dialog
// SEM_NOOPENFILEERRORBOX (0x8000) - Don't display the file-not-found message box
SetErrorMode(0x0001 | 0x0002 | 0x8000);

var builder = Host.CreateApplicationBuilder(args);

// Enable running as a Windows Service
builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "CCS QB Relay";
});

// Register our services
builder.Services.AddSingleton<QbWorker>();
builder.Services.AddHostedService<RelayHostedService>();

var host = builder.Build();
host.Run();

[DllImport("kernel32.dll")]
static extern uint SetErrorMode(uint uMode);
