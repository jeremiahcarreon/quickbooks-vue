using CcsQbRelay;
using Microsoft.Extensions.Hosting.WindowsServices;

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
