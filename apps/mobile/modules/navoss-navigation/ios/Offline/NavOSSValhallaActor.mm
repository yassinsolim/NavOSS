// Adapted from Rallista valhalla-mobile 0.6.4 `apple/Sources/ValhallaObjc/ValhallaWrapper.mm`
// (MIT, Copyright (c) 2024 Adventure Consortium Inc (dba Rallista), (c) 2018 Valhalla
// contributors). NavOSS only needs `route` against a local tar, so no HTTP tile client is
// installed and the wrapper's C++ headers (Boost, Abseil, Protobuf) are not included: the three
// entry points below are declared exactly as `include/main.h` declares them for Apple platforms.

#import "NavOSSValhallaActor.h"

#include <exception>
#include <string>

class ValhallaMobileHttpClient;
std::string route(const char *request, void *actor);
void *create_valhalla_actor(const char *config_path, ValhallaMobileHttpClient *http_client);
void delete_valhalla_actor(void *actor);

@implementation NavOSSValhallaActor {
  void *_actor;
}

- (nullable instancetype)initWithConfigPath:(NSString *)configPath
                                      error:(NSError *_Nullable *_Nullable)error {
  self = [super init];
  if (self == nil) {
    return nil;
  }
  try {
    _actor = create_valhalla_actor(configPath.fileSystemRepresentation, nullptr);
  } catch (const std::exception &exception) {
    if (error != NULL) {
      *error = [NSError errorWithDomain:@"org.navoss.valhalla"
                                   code:-1
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     [NSString stringWithUTF8String:exception.what()] ?: @""
                               }];
    }
    return nil;
  } catch (...) {
    if (error != NULL) {
      *error = [NSError errorWithDomain:@"org.navoss.valhalla" code:-1 userInfo:nil];
    }
    return nil;
  }
  if (_actor == nullptr) {
    if (error != NULL) {
      *error = [NSError errorWithDomain:@"org.navoss.valhalla" code:-2 userInfo:nil];
    }
    return nil;
  }
  return self;
}

- (NSString *)route:(NSString *)request {
  @synchronized(self) {
    if (_actor == nullptr) {
      return @"{\"code\":-1,\"message\":\"the actor is closed\"}";
    }
    try {
      std::string result = route(request.UTF8String, _actor);
      NSString *response = [[NSString alloc] initWithBytes:result.data()
                                                    length:result.size()
                                                  encoding:NSUTF8StringEncoding];
      return response ?: @"{\"code\":-1,\"message\":\"response was not valid UTF-8\"}";
    } catch (...) {
      return @"{\"code\":-1,\"message\":\"the engine raised an exception\"}";
    }
  }
}

- (void)close {
  @synchronized(self) {
    if (_actor != nullptr) {
      delete_valhalla_actor(_actor);
      _actor = nullptr;
    }
  }
}

- (void)dealloc {
  [self close];
}

@end
