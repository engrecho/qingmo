// Small native Launch Services bridge. No shell, administrator privileges or
// third-party utility; defaults change only after the user clicks Repair.
#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    BOOL repair = argc > 1 && strcmp(argv[1], "register") == 0;
    NSString *bundle = @"cn.bajiaolu.qingmo";
    OSStatus registration = noErr;
    if (repair) {
      if (argc != 3) return 2;
      NSURL *url = [NSURL fileURLWithPath:@(argv[2]) isDirectory:YES];
      NSBundle *app = [NSBundle bundleWithURL:url];
      if (![[app bundleIdentifier] isEqualToString:bundle]) return 3;
      registration = LSRegisterURL((__bridge CFURLRef)url, true);
    }
    NSArray *extensions = @[@"md", @"markdown", @"mdown", @"mkd", @"mkdn", @"mdtxt", @"mdtext"];
    NSMutableArray *results = [NSMutableArray array];
    for (NSString *ext in extensions) {
      CFStringRef type = UTTypeCreatePreferredIdentifierForTag(kUTTagClassFilenameExtension, (__bridge CFStringRef)ext, kUTTypePlainText);
      OSStatus status = registration;
      if (!type) status = paramErr;
      else if (repair && status == noErr) {
        // Existing role-specific choices override LSHandlerRoleAll. Set the two
        // document roles explicitly, then let a fresh process verify the result.
        status = LSSetDefaultRoleHandlerForContentType(type, kLSRolesEditor, (__bridge CFStringRef)bundle);
        if (status == noErr) status = LSSetDefaultRoleHandlerForContentType(type, kLSRolesViewer, (__bridge CFStringRef)bundle);
      }
      NSString *handler = type ? CFBridgingRelease(LSCopyDefaultRoleHandlerForContentType(type, kLSRolesEditor)) : nil;
      BOOL isQingMo = [handler caseInsensitiveCompare:bundle] == NSOrderedSame && handler != nil;
      [results addObject:@{@"ext":ext, @"progid":handler ?: @"(未关联)", @"isQingMo":@(isQingMo), @"ok":@(status == noErr), @"status":@(status)}];
      if (type) CFRelease(type);
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
    if (!json) return 4;
    fwrite(json.bytes, 1, json.length, stdout);
    return 0;
  }
}
