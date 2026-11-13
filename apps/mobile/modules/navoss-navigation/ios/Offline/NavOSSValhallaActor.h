#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// One Valhalla 3.9.1 actor over a local routing tar, from the vendored valhalla-mobile engine.
///
/// The actor is not thread-safe; every call is serialised on the instance. Building it maps the
/// tile extract, so callers keep one instance alive and swap it only between requests.
@interface NavOSSValhallaActor : NSObject

- (nullable instancetype)initWithConfigPath:(NSString *)configPath
                                      error:(NSError *_Nullable *_Nullable)error
    NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Runs Valhalla's `route` action. Returns the engine's response body, or the wrapper's
/// `{"code": …, "message": …}` envelope when the engine raised an error.
- (NSString *)route:(NSString *)request;

/// Releases the actor and its mapped tile extract. Safe to call more than once.
- (void)close;

@end

NS_ASSUME_NONNULL_END
