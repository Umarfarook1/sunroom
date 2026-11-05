// camctl: read (and optionally set) UVC controls of the first video capture device via DirectShow.
//   camctl list
//   camctl set <amp|cam> <propId> <value> <flags: 1=auto 2=manual>
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICreateDevEnum { [PreserveSig] int CreateClassEnumerator([In] ref Guid type, out IEnumMoniker e, int flags); }

[ComImport, Guid("C6E13360-30AC-11d0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAMVideoProcAmp {
    [PreserveSig] int GetRange(int prop, out int min, out int max, out int step, out int def, out int caps);
    [PreserveSig] int Set(int prop, int val, int flags);
    [PreserveSig] int Get(int prop, out int val, out int flags);
}

[ComImport, Guid("C6E13370-30AC-11d0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAMCameraControl {
    [PreserveSig] int GetRange(int prop, out int min, out int max, out int step, out int def, out int caps);
    [PreserveSig] int Set(int prop, int val, int flags);
    [PreserveSig] int Get(int prop, out int val, out int flags);
}

static class CamCtl {
    static readonly string[] Amp = { "Brightness", "Contrast", "Hue", "Saturation", "Sharpness", "Gamma", "ColorEnable",
        "WhiteBalance", "BacklightCompensation", "Gain", "DigitalMultiplier", "DigitalMultiplierLimit",
        "WhiteBalanceComponent", "PowerlineFrequency" };
    static readonly string[] Cam = { "Pan", "Tilt", "Roll", "Zoom", "Exposure", "Iris", "Focus", "ScanMode", "Privacy",
        "PanTilt", "PanRelative", "TiltRelative", "RollRelative", "ZoomRelative", "ExposureRelative", "IrisRelative",
        "FocusRelative", "PanTiltRelative", "FocalLength", "AutoExposurePriority" };

    [STAThread]
    static int Main(string[] a) {
        var devEnum = (ICreateDevEnum)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86")));
        Guid cat = new Guid("860BB310-5D01-11d0-BD3B-00A0C911CE86");
        IEnumMoniker en;
        if (devEnum.CreateClassEnumerator(ref cat, out en, 0) != 0 || en == null) { Console.WriteLine("no video devices"); return 1; }
        var mk = new IMoniker[1];
        if (en.Next(1, mk, IntPtr.Zero) != 0) { Console.WriteLine("no video devices"); return 1; }
        Guid iid = new Guid("56a86895-0ad4-11ce-b03a-0020af0ba770");
        object filter;
        mk[0].BindToObject(null, null, ref iid, out filter);
        var amp = filter as IAMVideoProcAmp;
        var cam = filter as IAMCameraControl;

        if (a.Length == 5 && a[0] == "set") {
            int p = int.Parse(a[2]), v = int.Parse(a[3]), f = int.Parse(a[4]);
            int hr = a[1] == "amp" ? amp.Set(p, v, f) : cam.Set(p, v, f);
            Console.WriteLine("set " + a[1] + " " + p + " = " + v + " flags " + f + " -> hr 0x" + hr.ToString("X8"));
            return hr == 0 ? 0 : 2;
        }
        Console.WriteLine("iface  id name                     min    max  step   def  caps(1=auto,2=manual)  current  flags");
        for (int i = 0; i < Amp.Length && amp != null; i++) {
            int mn, mx, st, df, cp, v, f;
            if (amp.GetRange(i, out mn, out mx, out st, out df, out cp) != 0) continue;
            amp.Get(i, out v, out f);
            Console.WriteLine("amp   {0,3} {1,-22} {2,6} {3,6} {4,5} {5,5}  {6,5}  {7,20}  {8,5}", i, Amp[i], mn, mx, st, df, cp, v, f);
        }
        for (int i = 0; i < Cam.Length && cam != null; i++) {
            int mn, mx, st, df, cp, v, f;
            if (cam.GetRange(i, out mn, out mx, out st, out df, out cp) != 0) continue;
            cam.Get(i, out v, out f);
            Console.WriteLine("cam   {0,3} {1,-22} {2,6} {3,6} {4,5} {5,5}  {6,5}  {7,20}  {8,5}", i, Cam[i], mn, mx, st, df, cp, v, f);
        }
        return 0;
    }
}
